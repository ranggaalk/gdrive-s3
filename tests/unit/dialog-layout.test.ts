import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

/**
 * Guards the modal layout contract.
 *
 * The original dialog had no height cap, so a long modal grew past the top and
 * bottom of the viewport. Because the panel is `fixed`, that overflow cannot be
 * scrolled to at all: the header was unreachable and the action buttons sat
 * below the fold. Individual call sites patched around it with
 * `max-h-[90vh] overflow-y-auto`, which scrolled the header and footer away too
 * and left the buttons at the end of a long scroll.
 *
 * HeroUI's Modal and AlertDialog now own that behaviour: with the default
 * `scroll="inside"` the dialog is capped to the container (itself sized to the
 * visual viewport) and only the body scrolls, so header and footer stay pinned.
 * These assertions keep the app relying on that instead of re-patching call
 * sites, and fail loudly if a HeroUI upgrade stops providing it.
 */
function readSource(relative: string): string {
  return readFileSync(new URL(`../../apps/web/src/${relative}`, import.meta.url).pathname, "utf8");
}

function readHeroCss(component: string): string {
  return readFileSync(
    new URL(`../../node_modules/@heroui/styles/dist/components/${component}.css`, import.meta.url).pathname,
    "utf8",
  );
}

/** The body of the first CSS rule whose selector is exactly `selector`. */
function cssRule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return "";
  return css.slice(start, css.indexOf("}", start));
}

/**
 * Every file that opens a dialog, wherever it lives. Dialogs started out only
 * in pages/, but a page large enough to split puts its dialog in a shared
 * component instead -- and that must not be how a call site slips out from
 * under this contract.
 */
function dialogCallSiteFiles(): string[] {
  const root = new URL("../../apps/web/src/", import.meta.url).pathname;
  const candidates = [
    ...readdirSync(`${root}pages/`).filter((f) => f.endsWith(".tsx")).map((f) => `pages/${f}`),
    ...readdirSync(`${root}components/`).filter((f) => f.endsWith(".tsx")).map((f) => `components/${f}`),
  ];
  return candidates.filter((file) => /<(?:Modal|AlertDialog)\.Dialog\b/.test(readSource(file)));
}

describe("HeroUI dialog styles the app relies on", () => {
  test("a modal caps its height and scrolls only the body", () => {
    const css = readHeroCss("modal");
    const dialog = cssRule(css, ".modal__dialog--scroll-inside");
    expect(dialog).toContain("max-h-full");
    // min-h-0 is what lets the column shrink below its content so the body,
    // not the whole panel, takes the overflow.
    expect(dialog).toContain("min-h-0");
    const body = cssRule(css, ".modal__body--scroll-inside");
    expect(body).toContain("overflow-y-auto");
    expect(cssRule(css, ".modal__body")).toContain("min-h-0");
  });

  test("a modal body leaves room for a focused field's ring", () => {
    // The scrolling body clips at its padding box, and a focused field draws a
    // 2px ring outside its own box. HeroUI pads the body by 3px and hands the
    // space back with a matching negative margin.
    const body = cssRule(readHeroCss("modal"), ".modal__body");
    expect(body).toContain("p-[3px]");
    expect(body).toContain("-m-[3px]");
  });

  test("an alert dialog body scrolls and can shrink", () => {
    const body = cssRule(readHeroCss("alert-dialog"), ".alert-dialog__body");
    expect(body).toContain("min-h-0");
    expect(body).toContain("overflow-y-auto");
  });

  test("the app's own CSS does not override the dialog layout", () => {
    // A rule whose subject is a dialog part (selector ends at `.modal__x {`)
    // could undo the cap or the scrolling body. Styling something *inside* a
    // dialog -- e.g. `.modal__dialog .alert` -- is fine.
    expect(readSource("index.css")).not.toMatch(/\.(?:modal|alert-dialog)__[\w-]+\s*\{/);
  });
});

describe("dialog call sites", () => {
  test("dialogs are found", () => {
    expect(dialogCallSiteFiles().length).toBeGreaterThan(5);
  });

  test.each(dialogCallSiteFiles())("%s does not cap or scroll a dialog by hand", (file) => {
    const source = readSource(file);
    const offenders = [
      ...source.matchAll(/<(?:Modal|AlertDialog)\.(?:Dialog|Container)\b[^>]*?className="([^"]*)"/g),
    ]
      .map((m) => m[1]!)
      .filter((cn) => /\bmax-h-|\boverflow-y-(?:auto|scroll)\b/.test(cn));
    expect(offenders).toEqual([]);
  });

  test.each(dialogCallSiteFiles())("%s keeps the scroll inside the dialog", (file) => {
    // scroll="outside" scrolls the whole page behind the modal, header and
    // footer included -- the behaviour this contract exists to prevent.
    expect(readSource(file)).not.toMatch(/scroll="outside"/);
  });

  test.each(dialogCallSiteFiles())("%s closes every dialog body it opens", (file) => {
    const source = readSource(file);
    const opened = source.match(/<(?:Modal|AlertDialog)\.Body[\s>]/g)?.length ?? 0;
    const closed = source.match(/<\/(?:Modal|AlertDialog)\.Body>/g)?.length ?? 0;
    expect(closed).toBe(opened);
  });

  test("a form wrapping a whole dialog is itself the column", () => {
    // When <form> wraps header, body, and footer it becomes the dialog's only
    // flex child, so the body cannot scroll unless the form is a shrinkable
    // flex column too.
    //
    // The tag cannot be matched with [^>]* because an inline arrow handler
    // contains a `>`; read the className attribute out of the tag instead.
    const forms: Array<{ file: string; className: string }> = [];
    for (const file of dialogCallSiteFiles()) {
      const source = readSource(file);
      for (const match of source.matchAll(/<(?:Modal|AlertDialog)\.Dialog[^>]*?>\s*(?:<[A-Za-z.]+CloseTrigger[^>]*\/>\s*)?<form/g)) {
        const tag = source.slice(match.index + match[0].length, match.index + match[0].length + 400);
        forms.push({ file, className: /className="([^"]*)"/.exec(tag)?.[1] ?? "" });
      }
    }

    expect(forms.length).toBeGreaterThan(0);
    for (const form of forms) {
      expect(`${form.file}: ${form.className}`).toContain("flex-col");
      expect(`${form.file}: ${form.className}`).toContain("min-h-0");
    }
  });
});
