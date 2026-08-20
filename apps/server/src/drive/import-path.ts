import { validateObjectKey } from "../s3/key.ts";

export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
export const DRIVE_SHORTCUT_MIME = "application/vnd.google-apps.shortcut";

export function encodeImportSegment(name: string): string {
  return name.replace(/%/g, "%25").replace(/\//g, "%2F");
}

export function importObjectKey(relativeFolder: string, name: string): string {
  const segment = encodeImportSegment(name);
  const key = relativeFolder ? `${relativeFolder}/${segment}` : segment;
  validateObjectKey(key, true);
  return key;
}

export function importFolderPath(relativeFolder: string, name: string): string {
  const segment = encodeImportSegment(name);
  const path = relativeFolder ? `${relativeFolder}/${segment}` : segment;
  validateObjectKey(path, true);
  return path;
}

export function unsupportedImportReason(input: {
  mimeType: string;
  canDownload: boolean;
  trashed: boolean;
  appProperties: Record<string, string>;
}): string | null {
  if (input.appProperties.drives3Type) return "managed_drives3_item";
  if (input.trashed) return "trashed";
  if (input.mimeType === DRIVE_SHORTCUT_MIME) return "shortcut_not_supported";
  if (input.mimeType.startsWith("application/vnd.google-apps.")) {
    return "google_native_not_supported";
  }
  if (!input.canDownload) return "download_not_allowed";
  return null;
}
