/** A plain uncompressed ustar fixture; production never writes archives. */
export function tarEntry(name: string, content: string, type = "0"): Buffer {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000600\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header.write(type, 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
    return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

export function fileTar(name: string, content: string, type = "0"): Buffer {
    return Buffer.concat([tarEntry(name, content, type), Buffer.alloc(1024)]);
}
