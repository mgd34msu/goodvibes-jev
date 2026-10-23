import { z } from '@goodvibes-jev/bash-zod';
export interface ShellCheckReplacement {
    precedence: number;
    line: number;
    endLine: number;
    column: number;
    endColumn: number;
    insertionPoint: string;
    replacement: string;
}
export type ShellCheckCommentLevel = 'error' | 'warning' | 'info' | 'style';
export interface ShellCheckComment {
    file: string;
    line: number;
    endLine: number;
    column: number;
    endColumn: number;
    level: ShellCheckCommentLevel;
    code: number;
    message: string;
    fix: { replacements: ShellCheckReplacement[] } | null;
}
export interface ShellCheckResult { comments: ShellCheckComment[]; }
export declare const ShellCheckResultSchema: z.ZodType<ShellCheckResult>;
