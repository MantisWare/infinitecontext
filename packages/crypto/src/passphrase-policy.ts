export class PassphrasePolicyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PassphrasePolicyError';
    }
}

export function assertVaultPassphrase(passphrase: string): void {
    const trimmed = passphrase.trim();
    if (trimmed.length === 0) {
        throw new PassphrasePolicyError('Vault passphrase cannot be empty.');
    }
    if (trimmed.length < 12) {
        throw new PassphrasePolicyError('Vault passphrase must be at least 12 characters.');
    }
    const hasLetter = /[A-Za-z]/.test(trimmed);
    const hasDigit = /\d/.test(trimmed);
    if (!hasLetter || !hasDigit) {
        throw new PassphrasePolicyError('Vault passphrase must include letters and numbers.');
    }
}
