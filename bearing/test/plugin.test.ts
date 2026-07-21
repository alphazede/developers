import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

describe("Bearing Codex plugin contract", () => {
  it("declares the local Bearing plugin and skill path", async () => {
    const manifest = JSON.parse(await read("../.codex-plugin/plugin.json"));
    expect(manifest).toMatchObject({
      name: "bearing",
      version: "0.1.0",
      skills: "./skills/",
      author: { name: "AlphaZede" },
      interface: { developerName: "AlphaZede" },
    });
    const packageJson = JSON.parse(await read("../package.json"));
    expect(packageJson.files).toEqual(expect.arrayContaining([
      ".codex-plugin/", "commands/", "skills/",
    ]));
  });

  it("keeps /bearing explicit and local", async () => {
    const command = await read("../commands/bearing.toml");
    expect(command).toContain("explicitly invokes /bearing");
    expect(command).toContain("installed `bearing` executable");
    expect(command).toContain("bearing/dist/cli.js");
    expect(command).toContain("start --no-open");
    expect(command).toContain("loopback URL");
    expect(command).toContain("Do not launch on SessionStart");
    expect(command).toContain("Codex native collaboration mode");
  });

  it("limits the skill to explicit planning-first launches", async () => {
    const skill = await read("../skills/bearing/SKILL.md");
    expect(skill).toContain("name: bearing");
    expect(skill).toContain("- developer");
    expect(skill).toContain("- public");
    expect(skill).toContain("explicit `/bearing` request");
    expect(skill).toContain("planning-first journey");
    expect(skill).toContain("Do not use");
  });
});
