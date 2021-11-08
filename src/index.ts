import cousinHarris, { CousinHarrisWatcher } from 'cousin-harris'
import * as fs from 'fs'
import { join as pathJoin } from 'path'
import * as ts from 'typescript'

const ROOT_DEBOUNCE = 500

const diagnosticFormatter = {
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getCanonicalFileName(path: string) {
    return path
  },
  getNewLine() {
    return ts.sys.newLine
  },
}

const noopCloseWatch = { close() {} }

function getParsedCommandLine(): ts.ParsedCommandLine {
  const config = ts.parseCommandLine(process.argv, (file) => fs.readFileSync(file).toString())
  const { options } = config
  const { project = '.' } = options
  const configIsNotExistingFile = !ts.sys.fileExists(project)
  const configFile = !configIsNotExistingFile
    ? project
    : ts.findConfigFile(options.project ?? '.', fs.existsSync)

  if (!configFile || (configFile === 'tsconfig.json' && configIsNotExistingFile)) {
    throw new Error('Could not find project')
  }

  const host: ts.ParseConfigFileHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: ts.sys.readDirectory,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    onUnRecoverableConfigFileDiagnostic(_diagnostic) {
      // doesn't seem any point to use this since fullConfig.errors is populated
    },
  }

  const fullConfig = ts.getParsedCommandLineOfConfigFile(configFile, options, host)

  if (!fullConfig) {
    throw new Error('Could not parse config for unknown reason')
  } else if (fullConfig.errors.length) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(fullConfig.errors, diagnosticFormatter),
    )
  } else {
    return fullConfig
  }
}

export function startWatchCompiler(
  host: ts.WatchCompilerHostOfFilesAndCompilerOptions<ts.EmitAndSemanticDiagnosticsBuilderProgram>,
): CousinHarrisWatcher {
  // watchman responds to every watch setup by listing every path in the root, this structure
  // is used to debounce each root after its setup so that these events can be ignored
  const rootDebounce = new Map<string, number>()

  const fileWatches = new Map<string, ts.FileWatcherCallback>()
  const directoryWatches = new Map<string, ts.DirectoryWatcherCallback>()

  const watcher: CousinHarrisWatcher = cousinHarris([], (change) => {
    const { root } = change

    const debounce = rootDebounce.get(root)
    if (debounce !== undefined) {
      const now = Date.now()
      const period = now - debounce
      if (period > ROOT_DEBOUNCE) {
        rootDebounce.delete(root)
      } else {
        // still debouncing the root
        rootDebounce.set(root, now)
        return
      }
    }

    if (change.isDirectory) {
      const { path } = change
      const fullPath = pathJoin(root, path)
      const watch = directoryWatches.get(fullPath)
      watch?.(fullPath)
    } else {
      const { path } = change
      if (!path.endsWith('.ts') && !path.endsWith('.tsx')) {
        return
      }

      const fullPath = pathJoin(root, path)
      const watch = fileWatches.get(fullPath)
      if (watch) {
        if (change.removal) {
          watch(fullPath, ts.FileWatcherEventKind.Deleted)
        } else {
          watch(fullPath, ts.FileWatcherEventKind.Changed)
        }
      } else {
        // how to signal a newly created file?
      }
    }
  })

  host.watchDirectory = (path, callback, _recursive, _options) => {
    directoryWatches.set(path, callback)
    rootDebounce.set(path, Date.now())
    watcher.addRoot(path)

    watcher.waitForWatches.catch(() => {
      console.warn(`Failed to watch directory: ${path}`)
      process.exit(1)
    })

    return {
      close() {
        // TODO: watcher.deleteRoot(path)
        directoryWatches.delete(path)
      },
    }
  }

  host.watchFile = (path, callback, _interval) => {
    fileWatches.set(path, callback)
    return {
      close() {
        fileWatches.delete(path)
      },
    }
  }

  return watcher
}

export async function main(): Promise<void> {
  try {
    const config = getParsedCommandLine()

    if (config.options.watch) {
      const host = ts.createWatchCompilerHost(
        config.fileNames,
        config.options,
        ts.sys,
        ts.createEmitAndSemanticDiagnosticsBuilderProgram,
        (diagnostic) => {
          console.log(ts.formatDiagnosticsWithColorAndContext([diagnostic], diagnosticFormatter))
        },
        undefined,
        config.projectReferences,
        {
          watchFile: ts.WatchFileKind.UseFsEventsOnParentDirectory,
          watchDirectory: ts.WatchDirectoryKind.UseFsEvents,
        },
      )

      const watcher = startWatchCompiler(host)
      ts.createWatchProgram(host)

      const stopWatching = watcher.stop
      process.on('exit', stopWatching)
      process.on('SIGTERM', stopWatching)
      process.on('SIGINT', stopWatching)
    } else {
      const program = ts.createIncrementalProgram({
        rootNames: config.fileNames,
        options: config.options,
      })
      program.getSemanticDiagnostics()
      const result = program.emit()
      if (result.emitSkipped) {
        console.log(
          ts.formatDiagnosticsWithColorAndContext(result.diagnostics, diagnosticFormatter),
        )
        process.exit(1)
      }
    }
  } catch (e) {
    if (e instanceof Error) {
      console.log(e.message)
    } else {
      console.log(e)
    }
    process.exit(1)
  }
}
