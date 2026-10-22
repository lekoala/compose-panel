/**
 * An owner/group pair different from what this process creates files with,
 * that this process is still allowed to chown to: any uid/gid when root,
 * otherwise a supplementary group of the current user. null when neither is
 * available (Windows, or a user with a single group), so the test skips.
 */
function pickForeignOwner(): { uid: number; gid: number } | null {
    if (process.platform === "win32" || !process.getuid || !process.getegid || !process.getgroups) return null;
    const uid = process.getuid();
    if (uid === 0) return { uid: 65534, gid: 65534 };
    const gid = process.getgroups().find((group) => group !== process.getegid!());
    return gid === undefined ? null : { uid, gid };
}

export const foreignOwner = pickForeignOwner();
