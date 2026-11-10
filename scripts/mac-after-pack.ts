// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - electron-builder hook with no Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

const prepareServerCompileCache: (context: AfterPackContext) => Promise<void> =
  NodeModule.createRequire(import.meta.url)("./prepare-server-compile-cache.cjs");

interface AfterPackContext {
  readonly appOutDir: string;
  readonly packager: { readonly appInfo: { readonly productFilename: string } };
}

// dyld refuses any image whose minimum macOS is newer than the running system, so a
// bundled native built for a newer release than Electron's own floor fails to load there.
export default async function afterPack(context: AfterPackContext): Promise<void> {
  await prepareServerCompileCache(context);
  const appDir = NodePath.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const floor = await readMinimumSystemVersion(NodePath.join(appDir, "Contents/Info.plist"));
  const report = await alignMachOMinimumVersions(
    NodePath.join(appDir, "Contents/Resources"),
    floor,
    adHocSign,
  );
  for (const file of report.lowered) {
    console.log(`[mac-after-pack] Lowered the minimum macOS of ${file} to ${floor}.`);
  }
  for (const { file, version } of report.tolerated) {
    console.warn(
      `[mac-after-pack] ${file} needs macOS ${version}; it loads lazily, so its feature is unavailable below that.`,
    );
  }
}

export async function readMinimumSystemVersion(plistPath: string): Promise<string> {
  const plist = await NodeFSP.readFile(plistPath, "utf8");
  const match = /<key>LSMinimumSystemVersion<\/key>\s*<string>([^<]+)<\/string>/u.exec(plist);
  if (!match?.[1]) throw new Error(`${plistPath} declares no LSMinimumSystemVersion.`);
  return match[1].trim();
}

const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;
const PLATFORM_MACOS = 1;

export interface MachOMinimumVersionField {
  readonly offset: number;
  readonly version: number;
}

export function encodeMachOVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number(part));
  return ((major << 16) | (minor << 8) | patch) >>> 0;
}

export function formatMachOVersion(encoded: number): string {
  return `${String(encoded >>> 16)}.${String((encoded >>> 8) & 0xff)}.${String(encoded & 0xff)}`;
}

/** Every macOS minimum-version field of a thin or fat image; undefined when the bytes are not Mach-O. */
export function findMachOMinimumVersionFields(
  image: Uint8Array,
): ReadonlyArray<MachOMinimumVersionField> | undefined {
  if (image.byteLength < 8) return undefined;
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  if (view.getUint32(0, false) !== FAT_MAGIC) return sliceFields(view, 0);
  const count = view.getUint32(4, false);
  if (8 + count * 20 > view.byteLength) return undefined;
  const fields: MachOMinimumVersionField[] = [];
  for (let index = 0; index < count; index++) {
    const slice = sliceFields(view, view.getUint32(8 + index * 20 + 8, false));
    if (!slice) return undefined;
    fields.push(...slice);
  }
  return fields;
}

function sliceFields(view: DataView, start: number): MachOMinimumVersionField[] | undefined {
  if (start + 32 > view.byteLength) return undefined;
  const magic = view.getUint32(start, true);
  if (magic !== MH_MAGIC && magic !== MH_MAGIC_64) return undefined;
  const commandCount = view.getUint32(start + 16, true);
  let cursor = start + (magic === MH_MAGIC_64 ? 32 : 28);
  const fields: MachOMinimumVersionField[] = [];
  for (let index = 0; index < commandCount; index++) {
    if (cursor + 16 > view.byteLength) return undefined;
    const command = view.getUint32(cursor, true);
    const size = view.getUint32(cursor + 4, true);
    if (command === LC_VERSION_MIN_MACOSX) {
      fields.push({ offset: cursor + 8, version: view.getUint32(cursor + 8, true) });
    } else if (
      command === LC_BUILD_VERSION &&
      view.getUint32(cursor + 8, true) === PLATFORM_MACOS
    ) {
      fields.push({ offset: cursor + 12, version: view.getUint32(cursor + 12, true) });
    }
    cursor += size;
  }
  return fields;
}

export type NativeMinimumVersionPolicy = "lower" | "tolerate" | "reject";

// fff links only libSystem and system frameworks, so its declared floor is the compiler
// default rather than a real requirement. objc-js needs libc++'s std::format, which
// arrived in macOS 13.3, and is only loaded when a preview passkey ceremony runs.
export function nativeMinimumVersionPolicy(file: string): NativeMinimumVersionPolicy {
  if (/\/node_modules\/@ff-labs\/fff-bin-darwin-[^/]+\/[^/]+\.dylib$/u.test(file)) return "lower";
  if (file.includes("/node_modules/objc-js/")) return "tolerate";
  return "reject";
}

export interface MinimumVersionReport {
  readonly lowered: ReadonlyArray<string>;
  readonly tolerated: ReadonlyArray<{ readonly file: string; readonly version: string }>;
}

export async function alignMachOMinimumVersions(
  root: string,
  floor: string,
  sign: (file: string) => Promise<void>,
): Promise<MinimumVersionReport> {
  const floorVersion = encodeMachOVersion(floor);
  const lowered: string[] = [];
  const tolerated: { file: string; version: string }[] = [];
  const rejected: string[] = [];
  for (const file of await listFiles(root)) {
    const image = await readIfMachO(file);
    if (!image) continue;
    const fields = findMachOMinimumVersionFields(image);
    if (!fields || fields.length === 0) continue;
    const highest = Math.max(...fields.map((field) => field.version));
    if (highest <= floorVersion) continue;
    const relative = `/${NodePath.relative(root, file).split(NodePath.sep).join("/")}`;
    const version = formatMachOVersion(highest);
    switch (nativeMinimumVersionPolicy(relative)) {
      case "lower": {
        const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
        for (const field of fields) {
          if (field.version > floorVersion) view.setUint32(field.offset, floorVersion, true);
        }
        await NodeFSP.writeFile(file, image);
        await sign(file);
        lowered.push(relative);
        break;
      }
      case "tolerate":
        tolerated.push({ file: relative, version });
        break;
      case "reject":
        rejected.push(`${relative} (macOS ${version})`);
        break;
    }
  }
  if (rejected.length > 0) {
    throw new Error(
      `These bundled binaries need a newer macOS than the app's ${floor} minimum:\n${rejected.join("\n")}`,
    );
  }
  return { lowered, tolerated };
}

// Walks by hand: recursive readdir follows directory symlinks out of the app folder.
async function listFiles(path: string): Promise<string[]> {
  const stats = await NodeFSP.lstat(path);
  if (stats.isSymbolicLink()) return [];
  if (!stats.isDirectory()) return [path];
  const files: string[] = [];
  for (const entry of await NodeFSP.readdir(path)) {
    files.push(...(await listFiles(NodePath.join(path, entry))));
  }
  return files;
}

async function readIfMachO(file: string): Promise<Uint8Array | undefined> {
  const handle = await NodeFSP.open(file, "r");
  try {
    const header = new Uint8Array(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    if (bytesRead < 4) return undefined;
    const view = new DataView(header.buffer);
    const little = view.getUint32(0, true);
    if (little !== MH_MAGIC && little !== MH_MAGIC_64 && view.getUint32(0, false) !== FAT_MAGIC) {
      return undefined;
    }
    return new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
}

// Rewriting load commands invalidates the linker's ad-hoc signature; electron-builder's
// own signing pass only runs for signed builds.
async function adHocSign(file: string): Promise<void> {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- electron-builder hook with no Effect runtime.
  if (process.platform !== "darwin") return;
  const result = NodeChildProcess.spawnSync("codesign", ["--force", "--sign", "-", file], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`codesign failed for ${file}: ${result.stderr || result.stdout}`);
  }
}
