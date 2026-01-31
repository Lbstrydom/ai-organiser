export interface CanvasNode {
    id: string;
    type: 'file' | 'text' | 'link' | 'group';
    x: number;
    y: number;
    width: number;
    height: number;
    file?: string;
    text?: string;
    url?: string;
    label?: string;
    color?: string;
}

export interface CanvasEdge {
    id: string;
    fromNode: string;
    toNode: string;
    fromSide: 'top' | 'right' | 'bottom' | 'left';
    toSide: 'top' | 'right' | 'bottom' | 'left';
    label?: string;
    color?: string;
}

export interface CanvasData {
    nodes: CanvasNode[];
    edges: CanvasEdge[];
}

export interface NodeDescriptor {
    id: string;
    label: string;
    type: 'file' | 'text' | 'link';
    file?: string;
    url?: string;
    text?: string;
    color?: string;
    width?: number;
    height?: number;
}

export interface EdgeDescriptor {
    fromId: string;
    toId: string;
    label?: string;
    color?: string;
}

export interface ClusterDescriptor {
    label: string;
    nodeIds: string[];
    color?: string;
}

export type CanvasErrorCode =
    | 'no-related-notes'
    | 'no-sources-detected'
    | 'no-notes-with-tag'
    | 'creation-failed';

export interface CanvasResult {
    success: boolean;
    filePath?: string;
    error?: string;
    errorCode?: CanvasErrorCode;
}
