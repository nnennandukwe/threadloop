#!/usr/bin/env node
import { createThreadloopProgram, handleCliError } from './cli-program.js';

createThreadloopProgram().parseAsync(process.argv).catch(handleCliError);
