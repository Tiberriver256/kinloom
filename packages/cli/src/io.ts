export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export const DEFAULT_IO: CliIo = {
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
};
