import { Buffer } from "node:buffer";

/**
 * In-memory ZIP (method 0, stored). Metadata deploys are built and parsed in
 * process memory and are never written to disk.
 */

export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  CRC_TABLE[index] = crc >>> 0;
}

const crc32 = (data: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const u16 = (value: number): Buffer => Buffer.from([value & 0xff, (value >>> 8) & 0xff]);

const u32 = (value: number): Buffer =>
  Buffer.from([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);

/** Build a stored ZIP archive. Entry names use forward slashes. */
export const zipStore = (entries: ReadonlyArray<ZipEntry>): Uint8Array => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replaceAll("\\", "/"), "utf8");
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
      data,
    ]);
    locals.push(local);
    centrals.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ]),
    );
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, central, end]);
};

const readU16 = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);

const readU32 = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) |
  ((bytes[offset + 1] ?? 0) << 8) |
  ((bytes[offset + 2] ?? 0) << 16) |
  ((bytes[offset + 3] ?? 0) << 24);

/** Read stored (and only stored) entries from a ZIP archive. */
export const unzipStore = (archive: Uint8Array): ZipEntry[] => {
  const entries: ZipEntry[] = [];
  let offset = 0;
  while (offset + 4 <= archive.length) {
    const signature = readU32(archive, offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) {
      return entries;
    }
    if (signature !== 0x04034b50) {
      throw new Error("ZIP archive is not a stored metadata package.");
    }
    if (offset + 30 > archive.length) {
      throw new Error("ZIP local header is truncated.");
    }
    const method = readU16(archive, offset + 8);
    if (method !== 0) {
      throw new Error("ZIP entry is compressed. Metadata packages are stored uncompressed.");
    }
    const compressedSize = readU32(archive, offset + 18);
    const nameLength = readU16(archive, offset + 26);
    const extraLength = readU16(archive, offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > archive.length) {
      throw new Error("ZIP entry extends past the end of the archive.");
    }
    const name = Buffer.from(archive.subarray(nameStart, nameStart + nameLength)).toString("utf8");
    entries.push({ name, data: archive.subarray(dataStart, dataEnd) });
    offset = dataEnd;
  }
  return entries;
};
