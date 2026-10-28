/**
 * Rejects C0 control characters and DEL (0x7f). They have no place in names,
 * paths, labels or other values that may reach logs, headers or templates.
 * Written without a regex so the intent stays explicit (and lintable).
 */
export function containsControlCharacters(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code <= 0x1f || code === 0x7f) return true;
    }
    return false;
}
