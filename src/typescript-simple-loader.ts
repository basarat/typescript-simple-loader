import { resolve, relative, dirname } from 'path'
import { readFileSync, statSync } from 'fs'
import { EOL } from 'os'
import * as ts from 'typescript'
import extend = require('xtend')
import { parseQuery, urlToRequest } from 'loader-utils'

interface WebPackLoader {
  cacheable(flag?: boolean): void
  query: string
  resourcePath: string
  context: string
  sourceMap: boolean
  loaderIndex: number
  _compiler: any
  addDependency(fileName: string): void
  clearDependencies(): void
  emitWarning(warning: string): void
  emitError(error: string): void
  callback(err: Error): void
  callback(err: void, contents: string, sourceMap?: SourceMap): void
  options: {
    context: string
  }
}

interface SourceMap {
  sources: string[]
  file: string
  sourcesContent: string[]
}

interface Options {
  compiler?: string
  configFile?: string
}

type FilesMap = ts.Map<{ version: number, text: string }>

interface LoaderInstance {
  files: FilesMap
  service: ts.LanguageService
}

/**
 * Hold a cache of loader instances.
 */
const loaderInstances: { [id: string]: LoaderInstance } = {}

/**
 * Keep temporary references to the current webpack loader for dependencies.
 */
let currentLoader: WebPackLoader

/**
 * Support TypeScript in Webpack.
 */
function loader (content: string): void {
  const loader: WebPackLoader = this
  const fileName = this.resourcePath
  const { files, service } = getLoaderInstance(this)
  let file = files[fileName]

  this.cacheable()

  // Set content on the first load. The watch task maintains reloads and
  // the version doesn't need to change when every dependency is re-run.
  if (!file) {
    file = files[fileName] = { version: 0, text: '' }
  }

  file.text = content
  file.version++

  currentLoader = loader
  const output = service.getEmitOutput(fileName)
  currentLoader = undefined

  if (output.emitSkipped) {
    loader.callback(new Error(`${fileName}: File not found`))
    return
  }

  const result = output.outputFiles[loader.sourceMap ? 1 : 0].text
  let sourceMap: SourceMap

  if (loader.sourceMap) {
    sourceMap = JSON.parse(output.outputFiles[0].text)
    sourceMap.sources = [fileName]
    sourceMap.file = fileName
    sourceMap.sourcesContent = [content]
  }

  loader.callback(null, result, sourceMap)
}

/**
 * Load a TypeScript configuration file.
 */
function loadConfigFile (fileName: string): any {
  return JSON.parse(readFileSync(fileName, 'utf-8'))
}

/**
 * Read the configuration into an object.
 */
function readConfigFile (configFile: string, loader: WebPackLoader, additionalOptions?: any) {
  let config = {
    files: <string[]> [],
    compilerOptions: {}
  }

  if (configFile) {
    const tsconfig = loadConfigFile(configFile)
    const configDir = dirname(configFile)

    config = extend(config, tsconfig)

    // Resolve and include `tsconfig.json` files.
    if (Array.isArray(tsconfig.files)) {
      config.files = config.files.map((file: string) => resolve(configDir, file))
    }
  }

  // Merge all the compiler options sources together.
  config.compilerOptions = extend({
    target: 'es5',
    module: 'commonjs'
  }, config.compilerOptions, additionalOptions, {
    sourceMap: loader.sourceMap
  })

  return config
}

/**
 * Create a TypeScript language service from the first instance.
 */
function createService (files: FilesMap, loader: WebPackLoader, options: Options) {
  const context = loader.context
  const rootFile = loader.resourcePath

  // Allow custom TypeScript compilers to be used.
  const TS: typeof ts = require(options.compiler || 'typescript')

  // Allow `configFile` option to override `tsconfig.json` lookup.
  const configFile = options.configFile ?
    resolve(context, options.configFile) :
    findConfigFile(dirname(rootFile))

  let config = TS.parseConfigFile(readConfigFile(configFile, loader))

  // Emit configuration errors.
  config.errors.forEach((error) => loader.emitError(formatDiagnostic(error)))

  const serviceHost: ts.LanguageServiceHost = {
    getScriptFileNames (): string[] {
      // Return an array of all file names. We can't return just the default
      // files because webpack may have traversed through a regular JS file
      // back to a TypeScript file and if we don't have that file in the array,
      // TypeScript will give us a file not found compilation error.
      return config.fileNames.concat(Object.keys(files))
    },
    getScriptVersion (fileName) {
      return files[fileName] && files[fileName].version.toString()
    },
    getScriptSnapshot (fileName: string): ts.IScriptSnapshot {
      const exists = fileExists(fileName)
      let file = files[fileName]

      // Load all files from the filesystem when they don't exist yet. This
      // is required for definition files and nested type information.
      if (exists) {
        if (!file) {
          try {
            file = files[fileName] = {
              version: 0,
              text: readFileSync(fileName, 'utf-8')
            }
          } catch (e) {
            return
          }
        }

        // Make the loader refresh when any external files change.
        if (currentLoader && isDefinition(fileName)) {
          currentLoader.addDependency(fileName)
        }

        return TS.ScriptSnapshot.fromString(file.text)
      }

      delete files[fileName]
    },
    getCurrentDirectory: () => context,
    getScriptIsOpen: () => true,
    getNewLine: () => EOL,
    getCompilationSettings: () => config.options,
    getDefaultLibFileName: (options: ts.CompilerOptions) => {
      return TS.getDefaultLibFilePath(config.options)
    }
  }

  const service = TS.createLanguageService(serviceHost, TS.createDocumentRegistry())

  // Hook into the watch plugin to update file dependencies in TypeScript
  // before the files are reloaded. This is required because we need type
  // information to propagate upward and Webpack reloads from the top down.
  loader._compiler.plugin('watch-run', function (watching: any, cb: () => void) {
    const mtimes = watching.compiler.watchFileSystem.watcher.mtimes

    Object.keys(mtimes)
      .forEach((fileName) => {
        const file = files[fileName]

        // Reload when a definition changes.
        if (file && isDefinition(fileName)) {
          file.text = readFileSync(fileName, 'utf8')
          file.version++
        }
      })

    cb()
  })

  // Push all semantic and outstanding compilation errors on emit. This allows
  // us to notify of all errors, including files outside webpacks knowledge.
  loader._compiler.plugin('emit', function (compilation: any, cb: () => void) {
    const program = service.getProgram()

    program.getSemanticDiagnostics().forEach((diagnostic) => {
      compilation.warnings.push(new DiagosticError(diagnostic, loader.options.context))
    })

    program.getSyntacticDiagnostics().forEach((diagnostic) => {
      compilation.errors.push(new DiagosticError(diagnostic, loader.options.context))
    })

    cb()
  })

  return service
}

/**
 * Check a file exists in the file system.
 */
function fileExists (fileName: string): boolean {
  try {
    return statSync(fileName).isFile()
  } catch (e) {
    return false
  }
}

/**
 * Format a diagnostic object into a string.
 */
function formatDiagnostic (diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')

  if (diagnostic.file) {
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)

    return `(${line + 1},${character + 1}): ${message}`
  }

  return message
}

/**
 * Create a Webpack-compatible diagnostic error.
 */
class DiagosticError implements Error {
  name = 'DiagnosticError'
  message: string
  file: string

  constructor (public diagnostic: ts.Diagnostic, public context: string) {
    this.message = formatDiagnostic(this.diagnostic)

    if (this.diagnostic.file) {
      this.file = urlToRequest(relative(context, this.diagnostic.file.fileName))
    }
  }
}

/**
 * Get the current TypeScript instance for the loader.
 *
 * @param  {WebPackLoader}  loader
 * @return {LoaderInstance}
 */
function getLoaderInstance (loader: WebPackLoader): LoaderInstance {
  const id = loader.options.context + loader.query
  const query = parseQuery(loader.query)

  if (loaderInstances[id]) {
    return loaderInstances[id]
  }

  const files: FilesMap = {}
  const service = createService(files, loader, query)
  const instance: LoaderInstance = { files, service }

  loaderInstances[id] = instance

  return instance
}

/**
 * Check if a file is a defintion.
 */
function isDefinition (fileName: string): boolean {
  return /\.d\.ts$/.test(fileName)
}

/**
 * Find the root config file.
 */
function findConfigFile (path: string): string {
  var dir = statSync(path).isDirectory() ? path : dirname(path)

  do {
    const configFile = resolve(dir, 'tsconfig.json')

    if (fileExists(configFile)) {
      return configFile
    }

    const parentDir = dirname(dir)

    if (dir === parentDir) {
      return
    }

    dir = parentDir
  } while (statSync(dir).isDirectory())
}

export = loader
