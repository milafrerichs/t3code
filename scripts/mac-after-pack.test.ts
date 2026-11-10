// @effect-diagnostics nodeBuiltinImport:off - Writes synthetic Mach-O images into a temporary app folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  alignMachOMinimumVersions,
  encodeMachOVersion,
  findMachOMinimumVersionFields,
  formatMachOVersion,
  readMinimumSystemVersion,
} from "./mac-after-pack.ts";

const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;

const buildVersionSize = (command: number) => (command === LC_BUILD_VERSION ? 24 : 16);

function thinImage(minimum: string, command = LC_BUILD_VERSION): Buffer {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeInt32LE(0x01000007, 4);
  header.writeUInt32LE(3, 8);
  header.writeUInt32LE(6, 12);
  header.writeUInt32LE(2, 16);
  header.writeUInt32LE(24 + buildVersionSize(command), 20);
  const buildVersion = Buffer.alloc(buildVersionSize(command));
  buildVersion.writeUInt32LE(command, 0);
  buildVersion.writeUInt32LE(buildVersion.byteLength, 4);
  if (command === LC_BUILD_VERSION) {
    buildVersion.writeUInt32LE(1, 8);
    buildVersion.writeUInt32LE(encodeMachOVersion(minimum), 12);
    buildVersion.writeUInt32LE(encodeMachOVersion("26.5"), 16);
  } else {
    buildVersion.writeUInt32LE(encodeMachOVersion(minimum), 8);
    buildVersion.writeUInt32LE(encodeMachOVersion("26.5"), 12);
  }
  // LC_UUID, so the walk has to step over an unrelated command.
  const uuid = Buffer.alloc(24);
  uuid.writeUInt32LE(0x1b, 0);
  uuid.writeUInt32LE(24, 4);
  return Buffer.concat([header, uuid, buildVersion, Buffer.from("code")]);
}

function fatImage(slices: ReadonlyArray<Buffer>): Buffer {
  const image = Buffer.alloc(4096 * (slices.length + 1));
  image.writeUInt32BE(0xcafebabe, 0);
  image.writeUInt32BE(slices.length, 4);
  slices.forEach((slice, index) => {
    const entry = 8 + index * 20;
    image.writeInt32BE(index === 0 ? 0x01000007 : 0x0100000c, entry);
    image.writeUInt32BE(4096 * (index + 1), entry + 8);
    image.writeUInt32BE(slice.byteLength, entry + 12);
    image.writeUInt32BE(12, entry + 16);
    slice.copy(image, 4096 * (index + 1));
  });
  return image;
}

const minimumOf = (image: Buffer) =>
  findMachOMinimumVersionFields(image)?.map((field) => formatMachOVersion(field.version));

describe("findMachOMinimumVersionFields", () => {
  it("reads LC_BUILD_VERSION and LC_VERSION_MIN_MACOSX from thin and fat images", () => {
    expect(minimumOf(thinImage("13.0"))).toEqual(["13.0.0"]);
    expect(minimumOf(thinImage("10.13", LC_VERSION_MIN_MACOSX))).toEqual(["10.13.0"]);
    expect(minimumOf(fatImage([thinImage("12.0"), thinImage("13.3.1")]))).toEqual([
      "12.0.0",
      "13.3.1",
    ]);
  });

  it("ignores files that are not Mach-O, including Java classes sharing the fat magic", () => {
    expect(findMachOMinimumVersionFields(Buffer.from("#!/bin/sh\nexit 0\n"))).toBeUndefined();
    const javaClass = Buffer.alloc(64);
    javaClass.writeUInt32BE(0xcafebabe, 0);
    javaClass.writeUInt32BE(0x00000041, 4);
    expect(findMachOMinimumVersionFields(javaClass)).toBeUndefined();
  });
});

describe("alignMachOMinimumVersions", () => {
  const files = {
    fff: "app.asar.unpacked/node_modules/@ff-labs/fff-bin-darwin-x64/libfff_c.dylib",
    objc: "app.asar.unpacked/node_modules/objc-js/prebuilds/darwin-x64/node.napi.node",
    ggml: "app.asar.unpacked/node_modules/@transcribe-cpp/darwin-x64-cpu/libggml.dylib",
    text: "app.asar.unpacked/node_modules/@ff-labs/fff-node/dist/index.js",
  } as const;

  async function stage(images: Record<string, Buffer>): Promise<string> {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mac-after-pack-"));
    for (const [file, image] of Object.entries(images)) {
      const target = NodePath.join(root, "Resources", file);
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      await NodeFSP.writeFile(target, image);
    }
    return root;
  }

  it("lowers fff, tolerates objc-js, and leaves everything else alone", async () => {
    const root = await stage({
      [files.fff]: fatImage([thinImage("13.0"), thinImage("11.0")]),
      [files.objc]: thinImage("13.3"),
      [files.ggml]: thinImage("11.0"),
      [files.text]: Buffer.from("export {};\n"),
    });
    try {
      await NodeFSP.symlink("../outside", NodePath.join(root, "Resources", "linked"));
      const sign = vi.fn(async () => undefined);

      const report = await alignMachOMinimumVersions(
        NodePath.join(root, "Resources"),
        "12.0",
        sign,
      );

      expect(report).toEqual({
        lowered: [`/${files.fff}`],
        tolerated: [{ file: `/${files.objc}`, version: "13.3.0" }],
      });
      expect(sign).toHaveBeenCalledWith(NodePath.join(root, "Resources", files.fff));
      const fff = await NodeFSP.readFile(NodePath.join(root, "Resources", files.fff));
      expect(minimumOf(fff)).toEqual(["12.0.0", "11.0.0"]);
      expect(
        minimumOf(await NodeFSP.readFile(NodePath.join(root, "Resources", files.objc))),
      ).toEqual(["13.3.0"]);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("fails the build for any other binary above the floor", async () => {
    const root = await stage({
      [files.ggml]: thinImage("14.0"),
      [files.fff]: thinImage("12.0"),
    });
    try {
      await expect(
        alignMachOMinimumVersions(NodePath.join(root, "Resources"), "12.0", async () => undefined),
      ).rejects.toThrow(`/${files.ggml} (macOS 14.0.0)`);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

describe("readMinimumSystemVersion", () => {
  it("reads LSMinimumSystemVersion from Info.plist", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mac-after-pack-"));
    try {
      const plist = NodePath.join(root, "Info.plist");
      await NodeFSP.writeFile(
        plist,
        "<plist><dict><key>CFBundleName</key><string>T3 Code</string>\n<key>LSMinimumSystemVersion</key>\n<string>12.0</string></dict></plist>",
      );
      expect(await readMinimumSystemVersion(plist)).toBe("12.0");
      await NodeFSP.writeFile(plist, "<plist><dict></dict></plist>");
      await expect(readMinimumSystemVersion(plist)).rejects.toThrow("LSMinimumSystemVersion");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
