/**
 * Golden fixture — the "Coffee & the global economy" deck expressed as IR.
 * Mirrors docs/plans/pres/Coffee & the global economy.html and exercises every
 * block kind. Used by slideIr / irToHtml / irToPptx tests as the regression deck.
 */

import { IR_SCHEMA_VERSION, type SlideDeckIr } from '../../src/services/presentationIr/slideIr';

export const coffeeDeckIr: SlideDeckIr = {
    schemaVersion: IR_SCHEMA_VERSION,
    title: 'Coffee & the global economy',
    slides: [
        {
            id: 's1',
            type: 'title',
            title: 'Coffee & the global economy',
            subtitle: 'How one beverage shapes trade, GDP, and livelihoods worldwide',
            blocks: [],
            notes: 'Coffee is the world\'s most traded agricultural commodity after oil.',
        },
        {
            id: 's2',
            type: 'content',
            title: "Coffee is the world's second most traded commodity",
            blocks: [
                { kind: 'paragraph', text: 'Only crude oil generates more global trade volume by value.' },
                {
                    kind: 'stat-grid',
                    cards: [
                        { value: '$100B+', label: 'Global retail coffee market value (2024)' },
                        { value: '125M', label: 'People whose livelihoods depend on coffee' },
                        { value: '10B kg', label: 'Coffee produced globally per year' },
                        { value: '70+', label: 'Countries where coffee is grown' },
                    ],
                },
            ],
        },
        {
            id: 's3',
            type: 'content',
            title: 'A handful of countries dominate supply',
            blocks: [
                {
                    kind: 'two-column',
                    left: [
                        { kind: 'caption', text: 'Share of global coffee production (2023 est.)' },
                        {
                            kind: 'bar-chart',
                            bars: [
                                { label: 'Brazil', pct: 37, color: '3b1a08' },
                                { label: 'Vietnam', pct: 17, color: '6b3520' },
                                { label: 'Colombia', pct: 8, color: '9a5530' },
                                { label: 'Indonesia', pct: 7, color: 'c8853a' },
                                { label: 'Ethiopia', pct: 5, color: 'd4a06a' },
                                { label: 'Others', pct: 26, color: 'e8d5bc' },
                            ],
                        },
                    ],
                    right: [
                        { kind: 'heading', text: 'Key insight', level: 3 },
                        { kind: 'paragraph', text: 'Brazil alone produces more than the next three largest producers combined.' },
                        { kind: 'paragraph', text: 'Geographic concentration means a drought or frost in one country can move global prices overnight.' },
                    ],
                },
            ],
        },
        {
            id: 's4',
            type: 'content',
            title: 'From farm to cup: a six-step value chain',
            blocks: [
                { kind: 'paragraph', text: 'Value is added — and captured — at every stage. Farmers receive the smallest share.' },
                {
                    kind: 'process-flow',
                    steps: [
                        { title: 'Farmer', sub: 'Grows & harvests cherry' },
                        { title: 'Processor', sub: 'Pulping, drying & milling' },
                        { title: 'Exporter', sub: 'Bags, grades & ships green bean' },
                        { title: 'Importer', sub: 'Buys at commodity exchange' },
                        { title: 'Roaster', sub: 'Transforms & brands' },
                        { title: 'Consumer', sub: 'Pays retail or café price' },
                    ],
                },
                { kind: 'callout', text: 'Farmers typically receive only 5–10% of the final retail price of a cup of coffee.', variant: 'info' },
            ],
        },
        {
            id: 's5',
            type: 'content',
            title: 'Coffee trade flows shape currency markets',
            blocks: [
                {
                    kind: 'two-column',
                    left: [
                        { kind: 'paragraph', text: 'Coffee is priced in US dollars on commodity exchanges. When the USD strengthens, producers earn less in local currency for the same price.' },
                        { kind: 'paragraph', text: "Brazil's Real and the Colombian Peso are partly driven by coffee export cycles — a well-known pattern among forex traders." },
                    ],
                    right: [
                        { kind: 'caption', text: 'Top importers by value' },
                        {
                            kind: 'table',
                            headers: ['Country', 'Import value'],
                            rows: [
                                ['USA', '$7.6B'],
                                ['Germany', '$3.5B'],
                                ['France', '$3.2B'],
                            ],
                        },
                    ],
                },
            ],
        },
        {
            id: 's6',
            type: 'content',
            title: 'Price swings create macro shockwaves',
            blocks: [
                { kind: 'caption', text: 'Arabica coffee futures price (illustrative trend, USD/lb)' },
                {
                    kind: 'svg',
                    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 300"><polyline fill="none" stroke="#c8853a" stroke-width="4" points="20,240 120,210 240,120 360,150 480,90 560,60"/></svg>',
                    alt: 'Arabica futures price trend 2018-2024',
                },
                { kind: 'caption', text: 'Source: ICE Futures U.S. (illustrative). Arabica (C contract).' },
            ],
        },
        {
            id: 's7',
            type: 'closing',
            title: 'Coffee is a macroeconomic force, not just a beverage',
            subtitle: 'Concentrated supply, fragile farmer margins, and dollar pricing make it a barometer of global trade health.',
            blocks: [],
            notes: 'Close on the takeaway: watch coffee as a leading indicator for commodity-dependent economies.',
        },
    ],
};
