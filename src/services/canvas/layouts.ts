export const DEFAULT_NODE_WIDTH = 400;
export const DEFAULT_NODE_HEIGHT = 200;
export const NODE_GAP = 60;
export const GROUP_PADDING = 60;
/** Maximum node count for radial layout; above this threshold grid layout is used. */
export const RADIAL_LAYOUT_THRESHOLD = 12;

export interface LayoutNode {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface GroupRect {
    x: number;
    y: number;
    width: number;
    height: number;
    label?: string;
    color?: string;
}

export function chooseLayout(count: number): 'radial' | 'grid' {
    return count <= RADIAL_LAYOUT_THRESHOLD ? 'radial' : 'grid';
}

export function radialLayout(
    count: number,
    centerIdx: number,
    width: number = DEFAULT_NODE_WIDTH,
    height: number = DEFAULT_NODE_HEIGHT
): LayoutNode[] {
    if (count <= 0) return [];

    const centerIndex = Math.max(0, Math.min(centerIdx, count - 1));
    const nodes: LayoutNode[] = Array.from({ length: count }, () => ({
        x: 0,
        y: 0,
        width,
        height
    }));

    if (count === 1) {
        return nodes;
    }

    const satelliteIndices = Array.from({ length: count }, (_, i) => i).filter(i => i !== centerIndex);
    const satelliteCount = satelliteIndices.length;
    const baseRadius = (width + NODE_GAP) * 1.5;
    const minRadius = (width + NODE_GAP) * (satelliteCount / (2 * Math.PI));
    const radius = Math.max(baseRadius, minRadius);

    for (let i = 0; i < satelliteCount; i++) {
        const angle = (2 * Math.PI * i) / satelliteCount;
        const index = satelliteIndices[i];
        nodes[index] = {
            x: Math.cos(angle) * radius,
            y: Math.sin(angle) * radius,
            width,
            height
        };
    }

    return nodes;
}

export function gridLayout(
    count: number,
    width: number = DEFAULT_NODE_WIDTH,
    height: number = DEFAULT_NODE_HEIGHT
): LayoutNode[] {
    if (count <= 0) return [];

    const cols = Math.ceil(Math.sqrt(count));
    const nodes: LayoutNode[] = [];

    for (let i = 0; i < count; i++) {
        const x = (i % cols) * (width + NODE_GAP);
        const y = Math.floor(i / cols) * (height + NODE_GAP);
        nodes.push({ x, y, width, height });
    }

    return nodes;
}

export function adaptiveLayout(
    count: number,
    centerIdx: number = 0,
    width: number = DEFAULT_NODE_WIDTH,
    height: number = DEFAULT_NODE_HEIGHT
): LayoutNode[] {
    return chooseLayout(count) === 'radial'
        ? radialLayout(count, centerIdx, width, height)
        : gridLayout(count, width, height);
}

export function clusteredLayout(
    clusters: { label: string; nodeCount: number; color?: string }[],
    width: number = DEFAULT_NODE_WIDTH,
    height: number = DEFAULT_NODE_HEIGHT
): { nodes: LayoutNode[]; groups: GroupRect[] } {
    const nodes: LayoutNode[] = [];
    const groups: GroupRect[] = [];

    let currentX = 0;

    for (const cluster of clusters) {
        const localNodes = gridLayout(cluster.nodeCount, width, height);
        const maxX = localNodes.reduce((max, node) => Math.max(max, node.x + node.width), 0);
        const maxY = localNodes.reduce((max, node) => Math.max(max, node.y + node.height), 0);
        const groupWidth = Math.max(maxX, width) + GROUP_PADDING * 2;
        const groupHeight = Math.max(maxY, height) + GROUP_PADDING * 2;

        const groupRect: GroupRect = {
            x: currentX,
            y: 0,
            width: groupWidth,
            height: groupHeight,
            label: cluster.label,
            color: cluster.color
        };

        groups.push(groupRect);

        for (const node of localNodes) {
            nodes.push({
                x: groupRect.x + GROUP_PADDING + node.x,
                y: groupRect.y + GROUP_PADDING + node.y,
                width: node.width,
                height: node.height
            });
        }

        currentX += groupWidth + NODE_GAP;
    }

    return { nodes, groups };
}

export function computeEdgeSides(
    from: { x: number; y: number },
    to: { x: number; y: number }
): { fromSide: 'top' | 'right' | 'bottom' | 'left'; toSide: 'top' | 'right' | 'bottom' | 'left' } {
    const dx = to.x - from.x;
    const dy = to.y - from.y;

    if (Math.abs(dx) > Math.abs(dy)) {
        return dx >= 0
            ? { fromSide: 'right', toSide: 'left' }
            : { fromSide: 'left', toSide: 'right' };
    }

    return dy >= 0
        ? { fromSide: 'bottom', toSide: 'top' }
        : { fromSide: 'top', toSide: 'bottom' };
}
