import { describe, expect, test } from "bun:test";
import { DriveClient } from "../../apps/server/src/drive/client.ts";

function jsonResponse(value: unknown): Response {
  return Response.json(value);
}

describe("DriveClient Shared Drive requests", () => {
  test("lists Shared Drives with capabilities", async () => {
    let requested: URL | null = null;
    const client = new DriveClient("token", 1, (async (input: string | URL | Request) => {
      requested = new URL(String(input));
      return jsonResponse({
        drives: [{ id: "d1", name: "Finance", capabilities: { canAddChildren: true } }],
      });
    }) as typeof fetch);
    const page = await client.listSharedDrives();
    expect(page.drives[0]?.id).toBe("d1");
    expect(requested).not.toBeNull();
    expect(requested!.pathname).toBe("/drive/v3/drives");
    expect(requested!.searchParams.get("fields")).toContain("canAddChildren");
  });

  test("scopes folder discovery to selected Shared Drive", async () => {
    let requested: URL | null = null;
    const client = new DriveClient("token", 1, (async (input: string | URL | Request) => {
      requested = new URL(String(input));
      return jsonResponse({ files: [] });
    }) as typeof fetch);
    await client.findByAppProperty(
      "drives3Type",
      "root:d1:user",
      undefined,
      { driveId: "d1" },
      "d1",
    );
    expect(requested).not.toBeNull();
    expect(requested!.searchParams.get("corpora")).toBe("drive");
    expect(requested!.searchParams.get("driveId")).toBe("d1");
    expect(requested!.searchParams.get("includeItemsFromAllDrives")).toBe("true");
    expect(requested!.searchParams.get("supportsAllDrives")).toBe("true");
    expect(requested!.searchParams.get("q")).toContain("'d1' in parents");
  });

  test("adds supportsAllDrives to Shared Drive folder creation", async () => {
    let requested: URL | null = null;
    const client = new DriveClient("token", 1, (async (input: string | URL | Request) => {
      requested = new URL(String(input));
      return jsonResponse({ id: "folder", name: "DriveS3 Gateway" });
    }) as typeof fetch);
    await client.createFolder(
      "DriveS3 Gateway",
      { drives3Type: "root" },
      "d1",
      undefined,
      { driveId: "d1" },
    );
    expect(requested).not.toBeNull();
    expect(requested!.searchParams.get("supportsAllDrives")).toBe("true");
  });
});
