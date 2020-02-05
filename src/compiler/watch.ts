/*@internal*/
namespace ts {
    const sysFormatDiagnosticsHost: FormatDiagnosticsHost = sys ? {
        getCurrentDirectory: () => sys.getCurrentDirectory(),
        getNewLine: () => sys.newLine,
        getCanonicalFileName: createGetCanonicalFileName(sys.useCaseSensitiveFileNames)
    } : undefined!; // TODO: GH#18217

    /**
     * Create a function that reports error by writing to the system and handles the formating of the diagnostic
     */
    export function createDiagnosticReporter(system: System, pretty?: boolean): DiagnosticReporter {
        const host: FormatDiagnosticsHost = system === sys ? sysFormatDiagnosticsHost : {
            getCurrentDirectory: () => system.getCurrentDirectory(),
            getNewLine: () => system.newLine,
            getCanonicalFileName: createGetCanonicalFileName(system.useCaseSensitiveFileNames),
        };
        if (!pretty) {
            return diagnostic => system.write(formatDiagnostic(diagnostic, host));
        }

        const diagnostics: Diagnostic[] = new Array(1);
        return diagnostic => {
            diagnostics[0] = diagnostic;
            system.write(formatDiagnosticsWithColorAndContext(diagnostics, host) + host.getNewLine());
            diagnostics[0] = undefined!; // TODO: GH#18217
        };
    }

    /**
     * @returns Whether the screen was cleared.
     */
    function clearScreenIfNotWatchingForFileChanges(system: System, diagnostic: Diagnostic, options: CompilerOptions): boolean {
        if (system.clearScreen &&
            !options.preserveWatchOutput &&
            !options.extendedDiagnostics &&
            !options.diagnostics &&
            contains(screenStartingMessageCodes, diagnostic.code)) {
            system.clearScreen();
            return true;
        }

        return false;
    }

    export const screenStartingMessageCodes: number[] = [
        Diagnostics.Starting_compilation_in_watch_mode.code,
        Diagnostics.File_change_detected_Starting_incremental_compilation.code,
    ];

    function getPlainDiagnosticFollowingNewLines(diagnostic: Diagnostic, newLine: string): string {
        return contains(screenStartingMessageCodes, diagnostic.code)
            ? newLine + newLine
            : newLine;
    }

    /**
     * Get locale specific time based on whether we are in test mode
     */
    export function getLocaleTimeString(system: System) {
        return !system.now ?
            new Date().toLocaleTimeString() :
            system.now().toLocaleTimeString("en-US", { timeZone: "UTC" });
    }

    /**
     * Create a function that reports watch status by writing to the system and handles the formating of the diagnostic
     */
    export function createWatchStatusReporter(system: System, pretty?: boolean): WatchStatusReporter {
        return pretty ?
            (diagnostic, newLine, options) => {
                clearScreenIfNotWatchingForFileChanges(system, diagnostic, options);
                let output = `[${formatColorAndReset(getLocaleTimeString(system), ForegroundColorEscapeSequences.Grey)}] `;
                output += `${flattenDiagnosticMessageText(diagnostic.messageText, system.newLine)}${newLine + newLine}`;
                system.write(output);
            } :
            (diagnostic, newLine, options) => {
                let output = "";

                if (!clearScreenIfNotWatchingForFileChanges(system, diagnostic, options)) {
                    output += newLine;
                }

                output += `${getLocaleTimeString(system)} - `;
                output += `${flattenDiagnosticMessageText(diagnostic.messageText, system.newLine)}${getPlainDiagnosticFollowingNewLines(diagnostic, newLine)}`;

                system.write(output);
            };
    }

    /** Parses config file using System interface */
    export function parseConfigFileWithSystem(configFileName: string, optionsToExtend: CompilerOptions, watchOptionsToExtend: WatchOptions | undefined, system: System, reportDiagnostic: DiagnosticReporter) {
        const host: ParseConfigFileHost = <any>system;
        host.onUnRecoverableConfigFileDiagnostic = diagnostic => reportUnrecoverableDiagnostic(system, reportDiagnostic, diagnostic);
        const result = getParsedCommandLineOfConfigFile(configFileName, optionsToExtend, host, /*extendedConfigCache*/ undefined, watchOptionsToExtend);
        host.onUnRecoverableConfigFileDiagnostic = undefined!; // TODO: GH#18217
        return result;
    }

    export function getErrorCountForSummary(diagnostics: readonly Diagnostic[]) {
        return countWhere(diagnostics, diagnostic => diagnostic.category === DiagnosticCategory.Error);
    }

    export function getWatchErrorSummaryDiagnosticMessage(errorCount: number) {
        return errorCount === 1 ?
            Diagnostics.Found_1_error_Watching_for_file_changes :
            Diagnostics.Found_0_errors_Watching_for_file_changes;
    }

    export function getErrorSummaryText(errorCount: number, newLine: string) {
        if (errorCount === 0) return "";
        const d = createCompilerDiagnostic(errorCount === 1 ? Diagnostics.Found_1_error : Diagnostics.Found_0_errors, errorCount);
        return `${newLine}${flattenDiagnosticMessageText(d.messageText, newLine)}${newLine}${newLine}`;
    }

    /**
     * Program structure needed to emit the files and report diagnostics
     */
    export interface ProgramToEmitFilesAndReportErrors {
        getCurrentDirectory(): string;
        getCanonicalFileName(fileName: string): string;
        getCompilerOptions(): CompilerOptions;
        getSourceFiles(): readonly SourceFile[];
        getSourceFileByPath(path: Path): SourceFile | undefined;
        getFileIncludeReasons(): MultiMap<Path, FileIncludeReason>;
        getSyntacticDiagnostics(sourceFile?: SourceFile, cancellationToken?: CancellationToken): readonly Diagnostic[];
        getOptionsDiagnostics(cancellationToken?: CancellationToken): readonly Diagnostic[];
        getGlobalDiagnostics(cancellationToken?: CancellationToken): readonly Diagnostic[];
        getSemanticDiagnostics(sourceFile?: SourceFile, cancellationToken?: CancellationToken): readonly Diagnostic[];
        getDeclarationDiagnostics(sourceFile?: SourceFile, cancellationToken?: CancellationToken): readonly DiagnosticWithLocation[];
        getConfigFileParsingDiagnostics(): readonly Diagnostic[];
        emit(targetSourceFile?: SourceFile, writeFile?: WriteFileCallback, cancellationToken?: CancellationToken, emitOnlyDtsFiles?: boolean, customTransformers?: CustomTransformers): EmitResult;
        emitBuildInfo(writeFile?: WriteFileCallback, cancellationToken?: CancellationToken): EmitResult;
    }

    export function listFiles(program: ProgramToEmitFilesAndReportErrors, write: (s: string) => void) {
        const options = program.getCompilerOptions();
        if (options.explainFiles) {
            explainFiles(program, write);
        }
        else if (options.listFiles || options.listFilesOnly) {
            forEach(program.getSourceFiles(), file => {
                write(file.fileName);
            });
        }
    }

    export function explainFiles(program: ProgramToEmitFilesAndReportErrors, write: (s: string) => void) {
        const reasons = program.getFileIncludeReasons();
        const filesByOrder = createMap<SourceFile[]>();
        for (const file of program.getSourceFiles()) {
            const order = reduceLeft(reasons.get(file.path), (memo, reason) => min(memo, reason.kind, compareValues), FileIncludeKind.AutomaticTypeDirectiveFile)!.toString();
            const existing = filesByOrder.get(order);
            if (existing) {
                existing.push(file);
            }
            else {
                filesByOrder.set(order, [file]);
            }
        }

        
        for (let order = FileIncludeKind.RootFile; order <= FileIncludeKind.AutomaticTypeDirectiveFile; order++) {
            const files = filesByOrder.get(order.toString());
            if (!files) continue;
            write(`${FileIncludeKind[order]}s::`);
            for (const file of files) {
                write(`${toFileName(program, file)}${file.redirectInfo ? " -> " + toFileName(program, file.redirectInfo.redirectTarget) : ""}`);
                for (const reason of reasons.get(file.path)!) {
                    if (reason.kind !== order ||
                        isReferencedFileKind(order) ||
                        (reason.kind === FileIncludeKind.AutomaticTypeDirectiveFile && !!reason.packageId)) {
                        // Add information about the reason
                        write(explainFileIncludeReason(program, reason));
                    }
                    //else if (reason.kind === FileIncludeKind.RootFile) {
                    //    //const include = getMatchingIncludeSpecFromConfigFilesSpecs(file, options.configFile.configFileSpecs);
                    //    //return include ?
                    //    //    `  ${FileIncludeKind[reason.kind]}:: Matched by include pattern '${include}' in tsconfig.json` :

                    //    for (const reason of reasons.get(file.path)!) {
                    //        if (reason.kind !== FileIncludeKind.RootFile) write(explainFileIncludeReason(program, reason));
                    //    }
                    //}
                }
            }
            write("");
        }
    }

    //function createRootFileExpainationWriter(program: ProgramToEmitFilesAndReportErrors, write: (s: string) => void): (file: SourceFile) => void {
    //    const options = program.getCompilerOptions();
    //    if (!options.configFile?.configFileSpecs) return noop;

    //    const { filesSpecs, validatedIncludeSpecs } = options.configFile.configFileSpecs;
    //    if (!validatedIncludeSpecs || !validatedIncludeSpecs.length) return writeMatchedByFiles;

    //    const basePath = getDirectoryPath(getNormalizedAbsolutePath(options.configFile.fileName, program.getCurrentDirectory()));
    //    let includeSpecs: { include: string; regExp: RegExp; }[] | undefined;
    //    for (const include of validatedIncludeSpecs) {
    //        const pattern = getPatternFromSpec(include, basePath, "files");
    //        if (!pattern) continue;
    //        (includeSpecs || (includeSpecs = [])).push({
    //            include,
    //            regExp: getRegexFromPattern(`(${pattern})$`, useCaseSensitiveFileNames)
    //        });
    //    }

    //    return !includeSpecs ?
    //        writeMatchedByFiles :
    //        !length(filesSpecs) ?
    //            writeMatchedByIncludeFile :
    //            writeMatchedByFilesOrInclude;

    //    function writeMatchedByFilesOrInclude(file: SourceFile) {
    //               //if (includeRe) {
    //    //    if (excludeRe) {
    //    //        return path => !(includeRe.test(path) && !excludeRe.test(path));
    //    //    }
    //    //    return path => !includeRe.test(path);
    //    //}
    //    //if (excludeRe) {
    //    //    return path => excludeRe.test(path);
    //    //}
    //    }


    //    //path = normalizePath(path);
    //    //currentDirectory = normalizePath(currentDirectory);
    //    //const absolutePath = combinePaths(currentDirectory, path);

    //    function writeMatchedByIncludeFile(file: SourceFile) {
    //        for (const spec of includeSpecs!) {
    //            if (spec.regExp.test(file.fileName)) {
    //                return writeMatchedByInclude(spec.include);
    //            }
    //        }
    //    }


 

    //    function writeMatchedByInclude(include: string) {
    //        write(`  ${FileIncludeKind[FileIncludeKind.RootFile]}:: Matched by include pattern '${include}' in tsconfig.json`);
    //    }

    //    function writeMatchedByFiles() {
    //        write(`  ${FileIncludeKind[FileIncludeKind.RootFile]}:: Part of 'files' list in tsconfig.json`);
    //    }
    //}

    function toFileName(program: ProgramToEmitFilesAndReportErrors, file: SourceFile | string) {
        return convertToRelativePath(isString(file) ? file : file.fileName, program.getCurrentDirectory(), fileName => program.getCanonicalFileName(fileName));
    }

    function explainFileIncludeReason(program: ProgramToEmitFilesAndReportErrors, reason: FileIncludeReason) {
        if (isReferencedFile(reason)) {
            const { file, pos, end, packageId } = getReferencedFileLocation(path => program.getSourceFileByPath(path), reason, /*includePackageId*/ true);
            return `  ${FileIncludeKind[reason.kind]}:: ${packageId? " " + packageIdToString(packageId) + ": " : ""}${file.text.substring(pos, end)} from ${toFileName(program, file)} ${reason.index}`;
        }
        if (reason.kind === FileIncludeKind.ProjectReferenceFile) {
            return `  ${FileIncludeKind[reason.kind]}:: from ${toFileName(program, reason.config)}`;
        }
        if (reason.kind === FileIncludeKind.AutomaticTypeDirectiveFile && reason.packageId) {
            return `  ${FileIncludeKind[reason.kind]}:: Package:: ${packageIdToString(reason.packageId)}`;
        }
        return `  ${FileIncludeKind[reason.kind]}`;
    }

    /**
     * Helper that emit files, report diagnostics and lists emitted and/or source files depending on compiler options
     */
    export function emitFilesAndReportErrors(
        program: ProgramToEmitFilesAndReportErrors,
        reportDiagnostic: DiagnosticReporter,
        write?: (s: string) => void,
        reportSummary?: ReportEmitErrorSummary,
        writeFile?: WriteFileCallback,
        cancellationToken?: CancellationToken,
        emitOnlyDtsFiles?: boolean,
        customTransformers?: CustomTransformers
    ) {
        const isListFilesOnly = !!program.getCompilerOptions().listFilesOnly;

        // First get and report any syntactic errors.
        const allDiagnostics = program.getConfigFileParsingDiagnostics().slice();
        const configFileParsingDiagnosticsLength = allDiagnostics.length;
        addRange(allDiagnostics, program.getSyntacticDiagnostics(/*sourceFile*/ undefined, cancellationToken));

        // If we didn't have any syntactic errors, then also try getting the global and
        // semantic errors.
        if (allDiagnostics.length === configFileParsingDiagnosticsLength) {
            addRange(allDiagnostics, program.getOptionsDiagnostics(cancellationToken));

            if (!isListFilesOnly) {
                addRange(allDiagnostics, program.getGlobalDiagnostics(cancellationToken));

                if (allDiagnostics.length === configFileParsingDiagnosticsLength) {
                    addRange(allDiagnostics, program.getSemanticDiagnostics(/*sourceFile*/ undefined, cancellationToken));
                }
            }
        }

        // Emit and report any errors we ran into.
        const emitResult = isListFilesOnly
            ? { emitSkipped: true, diagnostics: emptyArray }
            : program.emit(/*targetSourceFile*/ undefined, writeFile, cancellationToken, emitOnlyDtsFiles, customTransformers);
        const { emittedFiles, diagnostics: emitDiagnostics } = emitResult;
        addRange(allDiagnostics, emitDiagnostics);

        const diagnostics = sortAndDeduplicateDiagnostics(allDiagnostics);
        diagnostics.forEach(reportDiagnostic);
        if (write) {
            const currentDir = program.getCurrentDirectory();
            forEach(emittedFiles, file => {
                const filepath = getNormalizedAbsolutePath(file, currentDir);
                write(`TSFILE: ${filepath}`);
            });
            listFiles(program, write);
        }

        if (reportSummary) {
            reportSummary(getErrorCountForSummary(diagnostics));
        }

        return {
            emitResult,
            diagnostics,
        };
    }

    export function emitFilesAndReportErrorsAndGetExitStatus(
        program: ProgramToEmitFilesAndReportErrors,
        reportDiagnostic: DiagnosticReporter,
        write?: (s: string) => void,
        reportSummary?: ReportEmitErrorSummary,
        writeFile?: WriteFileCallback,
        cancellationToken?: CancellationToken,
        emitOnlyDtsFiles?: boolean,
        customTransformers?: CustomTransformers
    ) {
        const { emitResult, diagnostics } = emitFilesAndReportErrors(
            program,
            reportDiagnostic,
            write,
            reportSummary,
            writeFile,
            cancellationToken,
            emitOnlyDtsFiles,
            customTransformers
        );

        if (emitResult.emitSkipped && diagnostics.length > 0) {
            // If the emitter didn't emit anything, then pass that value along.
            return ExitStatus.DiagnosticsPresent_OutputsSkipped;
        }
        else if (diagnostics.length > 0) {
            // The emitter emitted something, inform the caller if that happened in the presence
            // of diagnostics or not.
            return ExitStatus.DiagnosticsPresent_OutputsGenerated;
        }
        return ExitStatus.Success;
    }

    export const noopFileWatcher: FileWatcher = { close: noop };
    export const returnNoopFileWatcher = () => noopFileWatcher;

    export function createWatchHost(system = sys, reportWatchStatus?: WatchStatusReporter): WatchHost {
        const onWatchStatusChange = reportWatchStatus || createWatchStatusReporter(system);
        return {
            onWatchStatusChange,
            watchFile: maybeBind(system, system.watchFile) || returnNoopFileWatcher,
            watchDirectory: maybeBind(system, system.watchDirectory) || returnNoopFileWatcher,
            setTimeout: maybeBind(system, system.setTimeout) || noop,
            clearTimeout: maybeBind(system, system.clearTimeout) || noop
        };
    }

    export type WatchType = WatchTypeRegistry[keyof WatchTypeRegistry];
    export const WatchType: WatchTypeRegistry = {
        ConfigFile: "Config file",
        SourceFile: "Source file",
        MissingFile: "Missing file",
        WildcardDirectory: "Wild card directory",
        FailedLookupLocations: "Failed Lookup Locations",
        TypeRoots: "Type roots"
    };

    export interface WatchTypeRegistry {
        ConfigFile: "Config file",
        SourceFile: "Source file",
        MissingFile: "Missing file",
        WildcardDirectory: "Wild card directory",
        FailedLookupLocations: "Failed Lookup Locations",
        TypeRoots: "Type roots"
    }

    interface WatchFactory<X, Y = undefined> extends ts.WatchFactory<X, Y> {
        writeLog: (s: string) => void;
    }

    export function createWatchFactory<Y = undefined>(host: { trace?(s: string): void; }, options: { extendedDiagnostics?: boolean; diagnostics?: boolean; }) {
        const watchLogLevel = host.trace ? options.extendedDiagnostics ? WatchLogLevel.Verbose : options.diagnostics ? WatchLogLevel.TriggerOnly : WatchLogLevel.None : WatchLogLevel.None;
        const writeLog: (s: string) => void = watchLogLevel !== WatchLogLevel.None ? (s => host.trace!(s)) : noop;
        const result = getWatchFactory<WatchType, Y>(watchLogLevel, writeLog) as WatchFactory<WatchType, Y>;
        result.writeLog = writeLog;
        return result;
    }

    export function createCompilerHostFromProgramHost(host: ProgramHost<any>, getCompilerOptions: () => CompilerOptions, directoryStructureHost: DirectoryStructureHost = host): CompilerHost {
        const useCaseSensitiveFileNames = host.useCaseSensitiveFileNames();
        const hostGetNewLine = memoize(() => host.getNewLine());
        return {
            getSourceFile: (fileName, languageVersion, onError) => {
                let text: string | undefined;
                try {
                    performance.mark("beforeIORead");
                    text = host.readFile(fileName, getCompilerOptions().charset);
                    performance.mark("afterIORead");
                    performance.measure("I/O Read", "beforeIORead", "afterIORead");
                }
                catch (e) {
                    if (onError) {
                        onError(e.message);
                    }
                    text = "";
                }

                return text !== undefined ? createSourceFile(fileName, text, languageVersion) : undefined;
            },
            getDefaultLibLocation: maybeBind(host, host.getDefaultLibLocation),
            getDefaultLibFileName: options => host.getDefaultLibFileName(options),
            writeFile,
            getCurrentDirectory: memoize(() => host.getCurrentDirectory()),
            useCaseSensitiveFileNames: () => useCaseSensitiveFileNames,
            getCanonicalFileName: createGetCanonicalFileName(useCaseSensitiveFileNames),
            getNewLine: () => getNewLineCharacter(getCompilerOptions(), hostGetNewLine),
            fileExists: f => host.fileExists(f),
            readFile: f => host.readFile(f),
            trace: maybeBind(host, host.trace),
            directoryExists: maybeBind(directoryStructureHost, directoryStructureHost.directoryExists),
            getDirectories: maybeBind(directoryStructureHost, directoryStructureHost.getDirectories),
            realpath: maybeBind(host, host.realpath),
            getEnvironmentVariable: maybeBind(host, host.getEnvironmentVariable) || (() => ""),
            createHash: maybeBind(host, host.createHash),
            readDirectory: maybeBind(host, host.readDirectory),
        };

        function writeFile(fileName: string, text: string, writeByteOrderMark: boolean, onError: (message: string) => void) {
            try {
                performance.mark("beforeIOWrite");

                // NOTE: If patchWriteFileEnsuringDirectory has been called,
                // the host.writeFile will do its own directory creation and
                // the ensureDirectoriesExist call will always be redundant.
                writeFileEnsuringDirectories(
                    fileName,
                    text,
                    writeByteOrderMark,
                    (path, data, writeByteOrderMark) => host.writeFile!(path, data, writeByteOrderMark),
                    path => host.createDirectory!(path),
                    path => host.directoryExists!(path));

                performance.mark("afterIOWrite");
                performance.measure("I/O Write", "beforeIOWrite", "afterIOWrite");
            }
            catch (e) {
                if (onError) {
                    onError(e.message);
                }
            }
        }
    }

    export function setGetSourceFileAsHashVersioned(compilerHost: CompilerHost, host: { createHash?(data: string): string; }) {
        const originalGetSourceFile = compilerHost.getSourceFile;
        const computeHash = host.createHash || generateDjb2Hash;
        compilerHost.getSourceFile = (...args) => {
            const result = originalGetSourceFile.call(compilerHost, ...args);
            if (result) {
                result.version = computeHash.call(host, result.text);
            }
            return result;
        };
    }

    /**
     * Creates the watch compiler host that can be extended with config file or root file names and options host
     */
    export function createProgramHost<T extends BuilderProgram = EmitAndSemanticDiagnosticsBuilderProgram>(system: System, createProgram: CreateProgram<T> | undefined): ProgramHost<T> {
        const getDefaultLibLocation = memoize(() => getDirectoryPath(normalizePath(system.getExecutingFilePath())));
        return {
            useCaseSensitiveFileNames: () => system.useCaseSensitiveFileNames,
            getNewLine: () => system.newLine,
            getCurrentDirectory: memoize(() => system.getCurrentDirectory()),
            getDefaultLibLocation,
            getDefaultLibFileName: options => combinePaths(getDefaultLibLocation(), getDefaultLibFileName(options)),
            fileExists: path => system.fileExists(path),
            readFile: (path, encoding) => system.readFile(path, encoding),
            directoryExists: path => system.directoryExists(path),
            getDirectories: path => system.getDirectories(path),
            readDirectory: (path, extensions, exclude, include, depth) => system.readDirectory(path, extensions, exclude, include, depth),
            realpath: maybeBind(system, system.realpath),
            getEnvironmentVariable: maybeBind(system, system.getEnvironmentVariable),
            trace: s => system.write(s + system.newLine),
            createDirectory: path => system.createDirectory(path),
            writeFile: (path, data, writeByteOrderMark) => system.writeFile(path, data, writeByteOrderMark),
            createHash: maybeBind(system, system.createHash),
            createProgram: createProgram || createEmitAndSemanticDiagnosticsBuilderProgram as any as CreateProgram<T>
        };
    }

    /**
     * Creates the watch compiler host that can be extended with config file or root file names and options host
     */
    function createWatchCompilerHost<T extends BuilderProgram = EmitAndSemanticDiagnosticsBuilderProgram>(system = sys, createProgram: CreateProgram<T> | undefined, reportDiagnostic: DiagnosticReporter, reportWatchStatus?: WatchStatusReporter): WatchCompilerHost<T> {
        const write = (s: string) => system.write(s + system.newLine);
        const result = createProgramHost(system, createProgram) as WatchCompilerHost<T>;
        copyProperties(result, createWatchHost(system, reportWatchStatus));
        result.afterProgramCreate = builderProgram => {
            const compilerOptions = builderProgram.getCompilerOptions();
            const newLine = getNewLineCharacter(compilerOptions, () => system.newLine);

            emitFilesAndReportErrors(
                builderProgram,
                reportDiagnostic,
                write,
                errorCount => result.onWatchStatusChange!(
                    createCompilerDiagnostic(getWatchErrorSummaryDiagnosticMessage(errorCount), errorCount),
                    newLine,
                    compilerOptions,
                    errorCount
                )
            );
        };
        return result;
    }

    /**
     * Report error and exit
     */
    function reportUnrecoverableDiagnostic(system: System, reportDiagnostic: DiagnosticReporter, diagnostic: Diagnostic) {
        reportDiagnostic(diagnostic);
        system.exit(ExitStatus.DiagnosticsPresent_OutputsSkipped);
    }

    export interface CreateWatchCompilerHostInput<T extends BuilderProgram> {
        system: System;
        createProgram?: CreateProgram<T>;
        reportDiagnostic?: DiagnosticReporter;
        reportWatchStatus?: WatchStatusReporter;
    }

    export interface CreateWatchCompilerHostOfConfigFileInput<T extends BuilderProgram> extends CreateWatchCompilerHostInput<T> {
        configFileName: string;
        optionsToExtend?: CompilerOptions;
        watchOptionsToExtend?: WatchOptions;
        extraFileExtensions?: readonly FileExtensionInfo[];
    }
    /**
     * Creates the watch compiler host from system for config file in watch mode
     */
    export function createWatchCompilerHostOfConfigFile<T extends BuilderProgram = EmitAndSemanticDiagnosticsBuilderProgram>({
        configFileName, optionsToExtend, watchOptionsToExtend, extraFileExtensions,
        system, createProgram, reportDiagnostic, reportWatchStatus
    }: CreateWatchCompilerHostOfConfigFileInput<T>): WatchCompilerHostOfConfigFile<T> {
        const diagnosticReporter = reportDiagnostic || createDiagnosticReporter(system);
        const host = createWatchCompilerHost(system, createProgram, diagnosticReporter, reportWatchStatus) as WatchCompilerHostOfConfigFile<T>;
        host.onUnRecoverableConfigFileDiagnostic = diagnostic => reportUnrecoverableDiagnostic(system, diagnosticReporter, diagnostic);
        host.configFileName = configFileName;
        host.optionsToExtend = optionsToExtend;
        host.watchOptionsToExtend = watchOptionsToExtend;
        host.extraFileExtensions = extraFileExtensions;
        return host;
    }

    export interface CreateWatchCompilerHostOfFilesAndCompilerOptionsInput<T extends BuilderProgram> extends CreateWatchCompilerHostInput<T> {
        rootFiles: string[];
        options: CompilerOptions;
        watchOptions: WatchOptions | undefined;
        projectReferences?: readonly ProjectReference[];
    }
    /**
     * Creates the watch compiler host from system for compiling root files and options in watch mode
     */
    export function createWatchCompilerHostOfFilesAndCompilerOptions<T extends BuilderProgram = EmitAndSemanticDiagnosticsBuilderProgram>({
        rootFiles, options, watchOptions, projectReferences,
        system, createProgram, reportDiagnostic, reportWatchStatus
    }: CreateWatchCompilerHostOfFilesAndCompilerOptionsInput<T>): WatchCompilerHostOfFilesAndCompilerOptions<T> {
        const host = createWatchCompilerHost(system, createProgram, reportDiagnostic || createDiagnosticReporter(system), reportWatchStatus) as WatchCompilerHostOfFilesAndCompilerOptions<T>;
        host.rootFiles = rootFiles;
        host.options = options;
        host.watchOptions = watchOptions;
        host.projectReferences = projectReferences;
        return host;
    }

    export interface IncrementalCompilationOptions {
        rootNames: readonly string[];
        options: CompilerOptions;
        configFileParsingDiagnostics?: readonly Diagnostic[];
        projectReferences?: readonly ProjectReference[];
        host?: CompilerHost;
        reportDiagnostic?: DiagnosticReporter;
        reportErrorSummary?: ReportEmitErrorSummary;
        afterProgramEmitAndDiagnostics?(program: EmitAndSemanticDiagnosticsBuilderProgram): void;
        system?: System;
    }
    export function performIncrementalCompilation(input: IncrementalCompilationOptions) {
        const system = input.system || sys;
        const host = input.host || (input.host = createIncrementalCompilerHost(input.options, system));
        const builderProgram = createIncrementalProgram(input);
        const exitStatus = emitFilesAndReportErrorsAndGetExitStatus(
            builderProgram,
            input.reportDiagnostic || createDiagnosticReporter(system),
            s => host.trace && host.trace(s),
            input.reportErrorSummary || input.options.pretty ? errorCount => system.write(getErrorSummaryText(errorCount, system.newLine)) : undefined
        );
        if (input.afterProgramEmitAndDiagnostics) input.afterProgramEmitAndDiagnostics(builderProgram);
        return exitStatus;
    }
}
