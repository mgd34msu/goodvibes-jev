import { z } from '@goodvibes-jev/bash-zod';
export interface Config {
    backgroundAnalysisMaxFiles: number;
    enableSourceErrorDiagnostics: boolean;
    globPattern: string;
    explainshellEndpoint: string;
    logLevel: 'debug' | 'info' | 'warning' | 'error';
    includeAllWorkspaceSymbols: boolean;
    shellcheckArguments: string[];
    shellcheckPath: string;
    shfmt: {
        path: string;
        ignoreEditorconfig: boolean;
        languageDialect: 'auto' | 'bash' | 'posix' | 'mksh' | 'bats';
        binaryNextLine: boolean;
        caseIndent: boolean;
        funcNextLine: boolean;
        keepPadding: boolean;
        simplifyCode: boolean;
        spaceRedirects: boolean;
    };
}
type ConfigInput = Partial<Omit<Config, 'shellcheckArguments' | 'shfmt'>> & {
    shellcheckArguments?: unknown;
    shfmt?: Partial<Config['shfmt']>;
};
export declare const ConfigSchema: z.ZodType<Config, ConfigInput>;
export declare function getConfigFromEnvironmentVariables(): {
    config: Config;
    environmentVariablesUsed: string[];
};
export declare function getDefaultConfiguration(): Config;
