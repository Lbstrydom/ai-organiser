/**
 * Strip image references from content
 * 
 * Handles different image handling modes:
 * - strip: Remove entirely
 * - placeholder: Replace with [Image: filename]
 * - exportAssets: Keep reference (assets copied separately)
 */

export type ImageHandlingMode = 'strip' | 'placeholder' | 'exportAssets';

export interface ImageStripResult {
    /** Transformed content */
    content: string;
    /** Images found (for asset export mode) */
    images: string[];
}

/**
 * Process images in content based on mode
 * @param content Note content
 * @param mode Image handling mode
 * @returns Transformed content and image list
 */
export function stripImages(content: string, mode: ImageHandlingMode): ImageStripResult {
    const images: string[] = [];

    // Match image embeds: ![[image.png]] or ![alt](image.png)
    const obsidianImageRegex = /!\[\[([^\]]+\.(png|jpg|jpeg|gif|svg|webp))\]\]/gi;
    const markdownImageRegex = /!\[([^\]]*)\]\(([^)]+\.(png|jpg|jpeg|gif|svg|webp))\)/gi;

    let result = content;

    if (mode === 'strip') {
        // Remove all image references
        result = result.replace(obsidianImageRegex, '');
        result = result.replace(markdownImageRegex, '');
    } else if (mode === 'placeholder') {
        // Replace with placeholders
        result = result.replace(obsidianImageRegex, (match, imagePath) => {
            const filename = imagePath.split('/').pop() || imagePath;
            images.push(imagePath);
            return `[Image: ${filename}]`;
        });

        result = result.replace(markdownImageRegex, (match, alt, imagePath) => {
            const filename = imagePath.split('/').pop() || imagePath;
            images.push(imagePath);
            return `[Image: ${filename}]`;
        });
    } else if (mode === 'exportAssets') {
        // Keep references, collect images for export
        let match;

        // Collect Obsidian-style images
        const obsidianRegex = /!\[\[([^\]]+\.(png|jpg|jpeg|gif|svg|webp))\]\]/gi;
        while ((match = obsidianRegex.exec(content)) !== null) {
            images.push(match[1]);
        }

        // Collect Markdown-style images
        const markdownRegex = /!\[([^\]]*)\]\(([^)]+\.(png|jpg|jpeg|gif|svg|webp))\)/gi;
        while ((match = markdownRegex.exec(content)) !== null) {
            images.push(match[2]);
        }

        // Content remains unchanged
        result = content;
    }

    return {
        content: result,
        images: [...new Set(images)] // Deduplicate
    };
}

/**
 * Extract all image paths from content (for analysis)
 * @param content Note content
 * @returns Array of unique image paths
 */
export function extractImagePaths(content: string): string[] {
    const images: string[] = [];

    // Obsidian-style images
    const obsidianImageRegex = /!\[\[([^\]]+\.(png|jpg|jpeg|gif|svg|webp))\]\]/gi;
    let match;
    while ((match = obsidianImageRegex.exec(content)) !== null) {
        images.push(match[1]);
    }

    // Markdown-style images
    const markdownImageRegex = /!\[([^\]]*)\]\(([^)]+\.(png|jpg|jpeg|gif|svg|webp))\)/gi;
    while ((match = markdownImageRegex.exec(content)) !== null) {
        images.push(match[2]);
    }

    return [...new Set(images)];
}
