import type { Mailer } from './types';

export function createConsoleMailer(): Mailer {
    return {
        async sendVerificationEmail({ to, verifyUrl }) {
            console.log(`[infinitecontext-mail] verify email to=${to} url=${verifyUrl}`);
        },
        async sendPasswordResetEmail({ to, resetUrl }) {
            console.log(`[infinitecontext-mail] password reset to=${to} url=${resetUrl}`);
        },
    };
}
