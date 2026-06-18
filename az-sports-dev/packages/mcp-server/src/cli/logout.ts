import * as fs from "node:fs";
import { writeCliStdout } from "../output-sink-registry.js";
import { deleteToken, getTokenFile } from "../token-store.js";

export async function runLogout(_args: string[] = []): Promise<number> {
  const tokenFile = getTokenFile();
  const hadToken = fs.existsSync(tokenFile);

  deleteToken();

  if (hadToken) {
    writeCliStdout(`Logged out. Token deleted from ${tokenFile}.\n`);
  } else {
    writeCliStdout("Logged out. (No stored token to delete.)\n");
  }

  return 0;
}
