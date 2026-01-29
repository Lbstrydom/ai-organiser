/**
 * Mock SecretStorage for testing SecretStorageService
 * Implements in-memory Map for CI/CD environments
 */

export class MockSecretStorage {
    private store: Map<string, string> = new Map();
    private available: boolean;

    constructor(available: boolean = true) {
        this.available = available;
    }

    // Obsidian 1.11+ SecretStorage API methods
    async getSecret(secretId: string): Promise<string | null> {
        if (!this.available) {
            throw new Error('SecretStorage not available');
        }
        return this.store.get(secretId) || null;
    }

    async setSecret(secretId: string, value: string): Promise<void> {
        if (!this.available) {
            throw new Error('SecretStorage not available');
        }
        this.store.set(secretId, value);
    }

    // Alias methods for compatibility
    async get(secretId: string): Promise<string | null> {
        return this.getSecret(secretId);
    }

    async set(secretId: string, value: string): Promise<void> {
        return this.setSecret(secretId, value);
    }

    async remove(secretId: string): Promise<void> {
        if (!this.available) {
            throw new Error('SecretStorage not available');
        }
        this.store.delete(secretId);
    }

    async delete(secretId: string): Promise<void> {
        return this.remove(secretId);
    }

    // Test helpers
    clear(): void {
        this.store.clear();
    }

    setAvailable(available: boolean): void {
        this.available = available;
    }

    getAll(): Map<string, string> {
        return new Map(this.store);
    }

    has(secretId: string): boolean {
        return this.store.has(secretId);
    }
}
