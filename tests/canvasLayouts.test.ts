import {
    adaptiveLayout,
    chooseLayout,
    clusteredLayout,
    computeEdgeSides,
    DEFAULT_NODE_HEIGHT,
    DEFAULT_NODE_WIDTH,
    gridLayout,
    radialLayout
} from '../src/services/canvas/layouts';

type Rect = { x: number; y: number; width: number; height: number };

function overlaps(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

describe('Canvas Layouts', () => {
    it('chooseLayout should return radial for <=12 and grid for >12', () => {
        expect(chooseLayout(1)).toBe('radial');
        expect(chooseLayout(12)).toBe('radial');
        expect(chooseLayout(13)).toBe('grid');
    });

    it('radialLayout should place single node at origin', () => {
        const nodes = radialLayout(1, 0);
        expect(nodes).toHaveLength(1);
        expect(nodes[0].x).toBe(0);
        expect(nodes[0].y).toBe(0);
    });

    it('radialLayout should place center and satellites', () => {
        const nodes = radialLayout(5, 0);
        expect(nodes).toHaveLength(5);
        expect(nodes[0].x).toBe(0);
        expect(nodes[0].y).toBe(0);
        const satellites = nodes.slice(1);
        const uniquePositions = new Set(satellites.map(n => `${n.x.toFixed(2)}:${n.y.toFixed(2)}`));
        expect(uniquePositions.size).toBe(4);
    });

    it('gridLayout should create non-overlapping grid', () => {
        const nodes = gridLayout(9);
        expect(nodes).toHaveLength(9);
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                expect(overlaps(nodes[i], nodes[j])).toBe(false);
            }
        }
    });

    it('adaptiveLayout should switch to grid after 12', () => {
        const radialNodes = adaptiveLayout(12, 0);
        const gridNodes = adaptiveLayout(13, 0);
        expect(radialNodes).toHaveLength(12);
        expect(gridNodes).toHaveLength(13);
    });

    it('clusteredLayout should keep groups separated and children inside bounds', () => {
        const { nodes, groups } = clusteredLayout([
            { label: 'Group A', nodeCount: 3 },
            { label: 'Group B', nodeCount: 2 }
        ]);

        expect(groups.length).toBe(2);
        expect(nodes.length).toBe(5);

        expect(overlaps(groups[0], groups[1])).toBe(false);

        const firstGroup = groups[0];
        const secondGroup = groups[1];
        const firstGroupNodes = nodes.slice(0, 3);
        const secondGroupNodes = nodes.slice(3);

        for (const node of firstGroupNodes) {
            expect(node.x).toBeGreaterThanOrEqual(firstGroup.x);
            expect(node.y).toBeGreaterThanOrEqual(firstGroup.y);
            expect(node.x + node.width).toBeLessThanOrEqual(firstGroup.x + firstGroup.width);
            expect(node.y + node.height).toBeLessThanOrEqual(firstGroup.y + firstGroup.height);
        }

        for (const node of secondGroupNodes) {
            expect(node.x).toBeGreaterThanOrEqual(secondGroup.x);
            expect(node.y).toBeGreaterThanOrEqual(secondGroup.y);
            expect(node.x + node.width).toBeLessThanOrEqual(secondGroup.x + secondGroup.width);
            expect(node.y + node.height).toBeLessThanOrEqual(secondGroup.y + secondGroup.height);
        }
    });

    it('computeEdgeSides should map quadrant directions', () => {
        expect(computeEdgeSides({ x: 0, y: 0 }, { x: 10, y: 0 })).toEqual({ fromSide: 'right', toSide: 'left' });
        expect(computeEdgeSides({ x: 0, y: 0 }, { x: -10, y: 0 })).toEqual({ fromSide: 'left', toSide: 'right' });
        expect(computeEdgeSides({ x: 0, y: 0 }, { x: 0, y: 10 })).toEqual({ fromSide: 'bottom', toSide: 'top' });
        expect(computeEdgeSides({ x: 0, y: 0 }, { x: 0, y: -10 })).toEqual({ fromSide: 'top', toSide: 'bottom' });
    });

    it('radialLayout(0, 0) should return empty array', () => {
        expect(radialLayout(0, 0)).toEqual([]);
    });

    it('gridLayout(0) should return empty array', () => {
        expect(gridLayout(0)).toEqual([]);
    });

    it('radialLayout should clamp out-of-bounds centerIdx', () => {
        const nodes = radialLayout(5, 999);
        expect(nodes).toHaveLength(5);
        // centerIdx clamped to 4 (last index), so node[4] should be at origin
        expect(nodes[4].x).toBe(0);
        expect(nodes[4].y).toBe(0);
    });

    it('computeEdgeSides should handle diagonal tie-break (dx === dy)', () => {
        // When dx === dy, Math.abs(dx) is NOT > Math.abs(dy), so falls to vertical branch
        const result = computeEdgeSides({ x: 0, y: 0 }, { x: 10, y: 10 });
        expect(result).toEqual({ fromSide: 'bottom', toSide: 'top' });
    });

    it('computeEdgeSides should handle same position (dx === 0, dy === 0)', () => {
        // Both are 0, falls to vertical branch with dy >= 0
        const result = computeEdgeSides({ x: 0, y: 0 }, { x: 0, y: 0 });
        expect(result).toEqual({ fromSide: 'bottom', toSide: 'top' });
    });

    it('clusteredLayout with single cluster should work', () => {
        const { nodes, groups } = clusteredLayout([
            { label: 'Solo', nodeCount: 3 }
        ]);
        expect(groups).toHaveLength(1);
        expect(nodes).toHaveLength(3);
        expect(groups[0].label).toBe('Solo');
    });

    it('clusteredLayout with empty cluster (nodeCount: 0) should work', () => {
        const { nodes, groups } = clusteredLayout([
            { label: 'Empty', nodeCount: 0 },
            { label: 'Full', nodeCount: 2 }
        ]);
        expect(groups).toHaveLength(2);
        expect(nodes).toHaveLength(2);
    });

    it('should avoid overlapping nodes for N=1..20', () => {
        for (let count = 1; count <= 20; count++) {
            const nodes = adaptiveLayout(count, 0, DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT);
            for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) {
                    expect(overlaps(nodes[i], nodes[j])).toBe(false);
                }
            }
        }
    });
});
