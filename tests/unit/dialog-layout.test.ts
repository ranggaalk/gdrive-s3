import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

/**
 * Guards the modal layout contract.
 *
 * The base dialog had no height cap, so a long modal grew past the top and
 * bottom of the viewport. Because the panel is `fixed`, that overflow cannot be
 * scrolled to at all: the header was unreachable and the action buttons sat
 * below the fold. Individual call sites patched around it with
 * `max-h-[90vh] overflow-y-auto`, which scrolled the header and footer away too
 * and left the buttons at the end of a long scroll.
 *
 * The fix belongs in the component: DialogContent caps its height and
 * DialogBody scrolls the middle while header and footer stay pinned. These
 * assertions stop the per-call-site patching from creeping back.
 */
function readSource(relative: string): string {
  return readFileSync(new URL(`../../apps/web/src/${relative}`, import.meta.url).pathname, "utf8");
}

function pageFiles(): string[] {
  const dir = new URL("../../apps/web/src/pages/", import.meta.url).pathname;
  return readdirSync(dir).filter((f) => f.endsWith(".tsx"));
}

const COMPONENTS: string[] = ["components/ui/dialog.tsx", "components/ui/alert-dialog.tsx"];

describe("dialog components", () => {
  test.each(COMPONENTS)("%s caps its height against the viewport", (file) => {
    const source = readSource(file);
    expect(source).toContain("max-h-[calc(100dvh-2rem)]");
  });

  test.each(COMPONENTS)("%s lays the panel out as a column", (file) => {
    const source = readSource(file);
    // Without flex-col the header/body/footer split cannot pin anything.
    expect(source).toMatch(/flex max-h-\[calc\(100dvh-2rem\)\][^"]*flex-col/);
  });

  test.each(COMPONENTS)("%s keeps the header and footer from shrinking", (file) => {
    const source = readSource(file);
    const header = /const \w*DialogHeader = [\s\S]*?\/>\s*\);/.exec(source)?.[0] ?? "";
    const footer = /const \w*DialogFooter = [\s\S]*?\/>\s*\);/.exec(source)?.[0] ?? "";
    expect(header).toContain("shrink-0");
    expect(footer).toContain("shrink-0");
  });

  test.each(COMPONENTS)("%s exposes a scrolling body that can shrink", (file) => {
    const source = readSource(file);
    const body = /const \w*DialogBody = [\s\S]*?\/>\s*\);/.exec(source)?.[0] ?? "";
    // min-h-0 is what lets a flex child shrink below its content height; without
    // it the body refuses to scroll and pushes the footer off screen instead.
    expect(body).toContain("min-h-0");
    expect(body).toContain("overflow-y-auto");
  });

  test.each(COMPONENTS)("%s lets children shrink below their content width", (file) => {
    // Replaces the grid-cols-[minmax(0,1fr)] the flex rewrite removed; without
    // it one long unbreakable string widens the whole panel.
    expect(readSource(file)).toContain("[&>*]:min-w-0");
  });
});

describe("dialog call sites", () => {
  test.each(pageFiles())("%s does not cap or scroll a dialog by hand", (file) => {
    const source = readSource(`pages/${file}`);
    const offenders = [...source.matchAll(/<(?:Alert)?DialogContent className="([^"]*)"/g)]
      .map((m) => m[1]!)
      .filter((cn) => /\bmax-h-\[|\boverflow-y-auto\b/.test(cn));
    expect(offenders).toEqual([]);
  });

  test.each(pageFiles())("%s closes every DialogBody it opens", (file) => {
    const source = readSource(`pages/${file}`);
    const opened = source.match(/<(?:Alert)?DialogBody[\s>]/g)?.length ?? 0;
    const closed = source.match(/<\/(?:Alert)?DialogBody>/g)?.length ?? 0;
    expect(closed).toBe(opened);
  });

  test("a form wrapping a whole dialog is itself the column", () => {
    // When <form> wraps header, body, and footer it becomes the only flex
    // child, so shrink-0 on the footer does nothing unless the form is a
    // flex column too.
    //
    // The tag cannot be matched with [^>]* because an inline arrow handler
    // contains a `>`; read the className attribute out of the tag instead.
    const forms: Array<{ file: string; className: string }> = [];
    for (const file of pageFiles()) {
      const source = readSource(`pages/${file}`);
      for (const match of source.matchAll(/<(?:Alert)?DialogContent[^>]*?>\s*<form/g)) {
        const tag = source.slice(match.index + match[0].length, match.index + match[0].length + 400);
        forms.push({ file, className: /className="([^"]*)"/.exec(tag)?.[1] ?? "" });
      }
    }

    expect(forms.length).toBeGreaterThan(0);
    for (const form of forms) {
      expect(`${form.file}: ${form.className}`).toContain("flex-col");
    }
  });
});
