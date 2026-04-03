declare module 'dom-to-pptx' {
    interface ExportOptions {
        fileName?: string;
        fonts?: Array<{ name: string; url: string }>;
        svgAsVector?: boolean;
    }

    export function exportToPptx(
        elements: HTMLElement | HTMLElement[] | NodeListOf<Element>,
        options?: ExportOptions
    ): Promise<void>;
}
