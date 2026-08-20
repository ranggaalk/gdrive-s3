// Tiny safe XML serializer for S3 responses. No parser, no DTD/external entity
// support. Every dynamic value passes through xmlEscape (AGENTS.md §12, §20).

export function xmlEscape(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function tag(name: string, value: unknown): string {
  return `<${name}>${xmlEscape(value)}</${name}>`;
}

export function xmlDocument(root: string, content: string, namespace = true): string {
  const ns = namespace ? ' xmlns="http://s3.amazonaws.com/doc/2006-03-01/"' : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${root}${ns}>${content}</${root}>`;
}

export function xmlResponse(xml: string, status = 200, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set("Content-Type", "application/xml");
  h.set("Content-Length", String(Buffer.byteLength(xml, "utf8")));
  return new Response(xml, { status, headers: h });
}
