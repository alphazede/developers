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
    expect(command).toContain("`../../dist/cli.js` relative to that skill's `SKILL.md` directory");
    expect(command).toContain("never resolve the fallback from the current or target repository");
    expect(command).toContain("instead of scanning other filesystem roots");
    expect(command.indexOf("installed `bearing` executable")).toBeLessThan(command.indexOf("`../../dist/cli.js`"));
    expect(command).toContain("with `start`");
    expect(command).not.toContain("start --no-open");
    expect(command).toContain("best-effort opens the browser automatically");
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
    expect(skill).toContain("keep\nPATH first");
    expect(skill).toContain("`../../dist/cli.js` relative to this `SKILL.md`\ndirectory");
    expect(skill).toContain("Never resolve the fallback from the current\nor target repository");
    expect(skill).toContain("filesystem-wide plugin discovery");
    expect(skill).toContain("with `start`");
    expect(skill).not.toContain("start --no-open");
    expect(skill).toContain("best-effort opens the browser automatically");
    expect(skill).toContain("planning-first journey");
    expect(skill).toContain("Do not use");
  });

  it("documents explicit browser launch without SessionStart ambiguity", async () => {
    const readme = await read("../README.md");
    expect(readme).toContain("not launch on SessionStart");
    expect(readme).toContain("After an explicit `/bearing`\ninvocation");
    expect(readme).toContain("best-effort opens the browser\nautomatically");
    expect(readme).not.toContain("does\nnot launch automatically");
  });
});
