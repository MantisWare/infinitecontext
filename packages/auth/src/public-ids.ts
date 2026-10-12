export function generateUserPublicId(): string {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    return `usr_${hex}`;
}

export function generateSessionPublicId(): string {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    return `ses_${hex}`;
}
