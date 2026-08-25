import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export const run = async (
  file: string,
  args: string[],
  options: { input?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> => {
  if (options.input !== undefined) {
    return await new Promise((resolve, reject) => {
      const child = execFile(
        file,
        args,
        {
          encoding: "utf8",
          timeout: options.timeout ?? 120_000,
          maxBuffer: 16 * 1024 * 1024,
          env: options.env,
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            reject(
              new Error(
                `${file} ${args.join(" ")} failed: ${stderr.trim() || error.message}`,
                {
                  cause: error,
                },
              ),
            );
            return;
          }
          resolve({ stdout, stderr });
        },
      );
      child.stdin?.end(options.input);
    });
  }
  const result = await execute(file, args, {
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    maxBuffer: 16 * 1024 * 1024,
    env: options.env,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};
