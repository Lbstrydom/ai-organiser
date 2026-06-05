/**
 * AI Organiser - Automated Tests
 * Run with: node scripts/automated-tests.js
 *
 * Tests that can run without Obsidian:
 * - TypeScript compilation
 * - i18n completeness
 * - Template syntax validation
 * - Filter injection logic
 * - Sanitization functions
 * - Settings defaults
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Test results
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`✓ ${name}`);
    } catch (error) {
        failed++;
        failures.push({ name, error: error.message });
        console.log(`✗ ${name}`);
        console.log(`  Error: ${error.message}`);
    }
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message || 'Assertion failed'}: expected "${expected}", got "${actual}"`);
    }
}

function assertTrue(value, message) {
    if (!value) {
        throw new Error(message || 'Expected true');
    }
}

function assertContains(str, substr, message) {
    if (!str.includes(substr)) {
        throw new Error(`${message || 'String does not contain expected substring'}: "${substr}"`);
    }
}

// ============================================
// 1. BUILD TESTS
// ============================================
console.log('\n=== BUILD TESTS ===\n');

test('TypeScript compiles without errors', () => {
    try {
        execSync('npx tsc -noEmit -skipLibCheck', { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
    } catch (error) {
        throw new Error('TypeScript compilation failed: ' + error.stdout?.toString() || error.message);
    }
});

test('Build produces main.js', () => {
    const mainPath = path.join(__dirname, '..', 'main.js');
    assertTrue(fs.existsSync(mainPath), 'main.js not found - run npm run build first');
});

// ============================================
// 2. I18N COMPLETENESS TESTS
// ============================================
console.log('\n=== I18N TESTS ===\n');

// (EN/ZH parity check removed — the Simplified-Chinese locale was dropped;
//  English is the only interface language. The i18n system itself remains.)

test('No missing i18n keys in types.ts', () => {
    const typesPath = path.join(__dirname, '..', 'src', 'i18n', 'types.ts');
    const enPath = path.join(__dirname, '..', 'src', 'i18n', 'en.ts');

    const typesContent = fs.readFileSync(typesPath, 'utf8');
    const enContent = fs.readFileSync(enPath, 'utf8');

    // Check that types file defines the structure
    assertContains(typesContent, 'export interface Translations', 'Missing Translations interface');
    assertContains(enContent, 'Translations', 'en.ts should implement Translations');
});

// ============================================
// 3. TEMPLATE TESTS
// ============================================
console.log('\n=== TEMPLATE TESTS ===\n');

test('Bases template uses correct syntax (filters: not filter:)', () => {
    const configPath = path.join(__dirname, '..', 'src', 'services', 'configurationService.ts');
    const content = fs.readFileSync(configPath, 'utf8');

    // Check DEFAULT_BASES_TEMPLATES uses 'filters:' not 'filter:'
    const templatesMatch = content.match(/DEFAULT_BASES_TEMPLATES[\s\S]*?^\];/m);
    // Audit Gemini-r2 G1 fix: assert the regex actually located the block
    // before running its inner checks. Previously a regex miss would
    // silently skip both `assertTrue` calls and report green.
    assertTrue(!!templatesMatch, 'Could not locate DEFAULT_BASES_TEMPLATES block');
    const templates = templatesMatch[0];
    assertTrue(!templates.includes("filter: '"), 'Template uses filter: instead of filters:');
    assertContains(templates, "filters:", 'Template should use filters:');
});

test('Bases template has required fields', () => {
    const configPath = path.join(__dirname, '..', 'src', 'services', 'configurationService.ts');
    const content = fs.readFileSync(configPath, 'utf8');

    assertContains(content, 'name:', 'Template missing name field');
    assertContains(content, 'columns:', 'Template missing columns field');
});

// ============================================
// 4. FILTER INJECTION TESTS
// ============================================
// Covered by production-module tests in `tests/dashboardService.test.ts`.

// ============================================
// 5. NOTEBOOKLM SERVICE TESTS
// ============================================
console.log('\n=== NOTEBOOKLM TESTS ===\n');

// Check core NotebookLM files exist
test('NotebookLM core files exist', () => {
    const notebooklmPath = path.join(__dirname, '..', 'src', 'services', 'notebooklm');

    const coreFiles = [
        'sourcePackService.ts',
        'selectionService.ts',
        'hashing.ts',
        'registry.ts',
        'types.ts',
        'writer.ts',
        'chunking.ts'
    ];

    for (const file of coreFiles) {
        const filePath = path.join(notebooklmPath, file);
        assertTrue(fs.existsSync(filePath), `Missing NotebookLM file: ${file}`);
    }
});

test('NotebookLM types are defined', () => {
    const typesPath = path.join(__dirname, '..', 'src', 'services', 'notebooklm', 'types.ts');
    const content = fs.readFileSync(typesPath, 'utf8');

    assertContains(content, 'SourcePack', 'Should define SourcePack type');
});

// ============================================
// 6. SETTINGS DEFAULTS TESTS
// ============================================
console.log('\n=== SETTINGS TESTS ===\n');

test('Default settings defined', () => {
    const settingsPath = path.join(__dirname, '..', 'src', 'core', 'settings.ts');
    const content = fs.readFileSync(settingsPath, 'utf8');

    assertContains(content, 'DEFAULT_SETTINGS', 'Missing DEFAULT_SETTINGS export');
    assertContains(content, 'enableStructuredMetadata', 'Missing Bases metadata setting');
    assertContains(content, 'enableSemanticSearch', 'Missing semantic search setting');
});

test('NotebookLM settings have defaults', () => {
    const settingsPath = path.join(__dirname, '..', 'src', 'core', 'settings.ts');
    const content = fs.readFileSync(settingsPath, 'utf8');

    assertContains(content, 'notebooklmSelectionTag', 'Missing NotebookLM selection tag setting');
    assertContains(content, 'notebooklmExportFolder', 'Missing NotebookLM export folder setting');
});

test('Output root folder setting has default', () => {
    const settingsPath = path.join(__dirname, '..', 'src', 'core', 'settings.ts');
    const content = fs.readFileSync(settingsPath, 'utf8');

    assertContains(content, 'outputRootFolder', 'Missing outputRootFolder setting');
    assertContains(content, "outputRootFolder: ''", 'outputRootFolder default should be empty string');
});

test('Minutes settings have defaults', () => {
    const settingsPath = path.join(__dirname, '..', 'src', 'core', 'settings.ts');
    const content = fs.readFileSync(settingsPath, 'utf8');

    assertContains(content, 'minutesOutputFolder', 'Missing minutes output folder setting');
    assertContains(content, 'minutesDefaultTimezone', 'Missing minutes default timezone setting');
    assertContains(content, 'minutesStyle', 'Missing minutes style setting');
    assertContains(content, 'minutesObsidianTasksFormat', 'Missing minutes tasks format setting');
});

// ============================================
// 7. COMMAND REGISTRATION TESTS
// ============================================
console.log('\n=== COMMAND TESTS ===\n');

test('Dashboard commands registered', () => {
    const cmdPath = path.join(__dirname, '..', 'src', 'commands', 'dashboardCommands.ts');
    const content = fs.readFileSync(cmdPath, 'utf8');

    assertContains(content, 'registerDashboardCommands', 'Missing command registration function');
    assertContains(content, 'DashboardCreationModal', 'Should use DashboardCreationModal');
});

test('NotebookLM commands registered', () => {
    const cmdPath = path.join(__dirname, '..', 'src', 'commands', 'notebookLMCommands.ts');
    const content = fs.readFileSync(cmdPath, 'utf8');

    assertContains(content, 'registerNotebookLMCommands', 'Missing command registration function');
    assertContains(content, 'toggle', 'Should have toggle command');
    assertContains(content, 'export', 'Should have export command');
});

test('Minutes command registered', () => {
    const cmdPath = path.join(__dirname, '..', 'src', 'commands', 'minutesCommands.ts');
    const content = fs.readFileSync(cmdPath, 'utf8');

    assertContains(content, 'registerMinutesCommands', 'Missing minutes command registration function');
    assertContains(content, 'create-meeting-minutes', 'Missing create meeting minutes command id');
});

test('Web Reader command registered', () => {
    const cmdPath = path.join(__dirname, '..', 'src', 'commands', 'webReaderCommands.ts');
    const content = fs.readFileSync(cmdPath, 'utf8');
    assertContains(content, 'registerWebReaderCommands', 'Missing web reader command registration function');
    assertContains(content, 'web-reader', 'Missing web-reader command id');
});

test('Kindle command registered', () => {
    const cmdPath = path.join(__dirname, '..', 'src', 'commands', 'kindleCommands.ts');
    const content = fs.readFileSync(cmdPath, 'utf8');
    assertContains(content, 'registerKindleCommands', 'Missing kindle command registration function');
    assertContains(content, 'kindle-sync', 'Missing kindle-sync command id');
});

test('Kindle index exports sync service', () => {
    const indexPath = path.join(__dirname, '..', 'src', 'services', 'kindle', 'index.ts');
    const content = fs.readFileSync(indexPath, 'utf8');
    assertContains(content, 'syncFromClippings', 'Missing syncFromClippings export');
    assertContains(content, 'getNewHighlights', 'Missing getNewHighlights export');
});

test('Kindle index exports auth service', () => {
    const indexPath = path.join(__dirname, '..', 'src', 'services', 'kindle', 'index.ts');
    const content = fs.readFileSync(indexPath, 'utf8');
    assertContains(content, 'validateCookies', 'Missing validateCookies export');
    assertContains(content, 'openAmazonInBrowser', 'Missing openAmazonInBrowser export');
    assertContains(content, 'getNotebookUrl', 'Missing getNotebookUrl export');
    assertContains(content, 'buildRequestHeaders', 'Missing buildRequestHeaders export');
    assertContains(content, 'isAuthenticated', 'Missing isAuthenticated export');
    assertContains(content, 'getStoredCookies', 'Missing getStoredCookies export');
    assertContains(content, 'storeCookies', 'Missing storeCookies export');
    assertContains(content, 'clearCookies', 'Missing clearCookies export');
});

test('Kindle index exports scraper service', () => {
    const indexPath = path.join(__dirname, '..', 'src', 'services', 'kindle', 'index.ts');
    const content = fs.readFileSync(indexPath, 'utf8');
    assertContains(content, 'fetchBookList', 'Missing fetchBookList export');
    assertContains(content, 'fetchAllHighlights', 'Missing fetchAllHighlights export');
    assertContains(content, 'parseBookListHTML', 'Missing parseBookListHTML export');
    assertContains(content, 'parseHighlightsHTML', 'Missing parseHighlightsHTML export');
});

test('Kindle index exports Phase 3 Amazon sync + types', () => {
    const indexPath = path.join(__dirname, '..', 'src', 'services', 'kindle', 'index.ts');
    const content = fs.readFileSync(indexPath, 'utf8');
    assertContains(content, 'syncFromAmazon', 'Missing syncFromAmazon export');
    assertContains(content, 'generateAmazonHighlightId', 'Missing generateAmazonHighlightId export');
    assertContains(content, 'toKindleBook', 'Missing toKindleBook export');
    assertContains(content, 'KindleAuthResult', 'Missing KindleAuthResult type export');
    assertContains(content, 'KindleCookiePayload', 'Missing KindleCookiePayload type export');
    assertContains(content, 'KindleScrapedBook', 'Missing KindleScrapedBook type export');
});

test('Kindle prompts barrel exports Phase 4 functions', () => {
    const indexPath = path.join(__dirname, '..', 'src', 'services', 'prompts', 'index.ts');
    const content = fs.readFileSync(indexPath, 'utf8');
    assertContains(content, 'buildBookSummaryPrompt', 'Missing buildBookSummaryPrompt export');
    assertContains(content, 'buildHighlightThemePrompt', 'Missing buildHighlightThemePrompt export');
});

test('Kindle prompts file exists with required functions', () => {
    const promptPath = path.join(__dirname, '..', 'src', 'services', 'prompts', 'kindlePrompts.ts');
    const content = fs.readFileSync(promptPath, 'utf8');
    assertContains(content, 'buildBookSummaryPrompt', 'Missing buildBookSummaryPrompt function');
    assertContains(content, 'buildHighlightThemePrompt', 'Missing buildHighlightThemePrompt function');
    assertContains(content, 'KindleBook', 'Missing KindleBook type import');
    assertContains(content, 'KindleHighlight', 'Missing KindleHighlight type import');
});

test('Research command registered', () => {
    const cmdPath = path.join(__dirname, '..', 'src', 'commands', 'researchCommands.ts');
    const content = fs.readFileSync(cmdPath, 'utf8');
    assertContains(content, 'registerResearchCommands', 'Missing research command registration function');
    assertContains(content, 'research-web', 'Missing research-web command id');
});

test('Research prompt exports exist', () => {
    const promptPath = path.join(__dirname, '..', 'src', 'services', 'prompts', 'researchPrompts.ts');
    const content = fs.readFileSync(promptPath, 'utf8');
    assertContains(content, 'buildQueryDecompositionPrompt', 'Missing buildQueryDecompositionPrompt');
    assertContains(content, 'buildResultTriagePrompt', 'Missing buildResultTriagePrompt');
    assertContains(content, 'buildSourceExtractionPrompt', 'Missing buildSourceExtractionPrompt');
    assertContains(content, 'buildSynthesisPrompt', 'Missing buildSynthesisPrompt');
    assertContains(content, 'buildContextualAnswerPrompt', 'Missing buildContextualAnswerPrompt');
});

test('URL utility exports exist', () => {
    const utilPath = path.join(__dirname, '..', 'src', 'utils', 'urlUtils.ts');
    const content = fs.readFileSync(utilPath, 'utf8');
    assertContains(content, 'normalizeUrl', 'Missing normalizeUrl export');
    assertContains(content, 'extractDomain', 'Missing extractDomain export');
    assertContains(content, 'classifyUrlSource', 'Missing classifyUrlSource export');
});

// ============================================
// 8. IMPORT/EXPORT CONSISTENCY
// ============================================
console.log('\n=== IMPORT CONSISTENCY TESTS ===\n');

test('Commands index registers all modules', () => {
    const indexPath = path.join(__dirname, '..', 'src', 'commands', 'index.ts');
    const content = fs.readFileSync(indexPath, 'utf8');

    assertContains(content, 'registerDashboardCommands', 'Missing dashboard commands registration');
    assertContains(content, 'registerNotebookLMCommands', 'Missing NotebookLM commands registration');
    assertContains(content, 'registerMinutesCommands', 'Missing minutes commands registration');
    assertContains(content, 'registerWebReaderCommands', 'Missing web reader commands registration');
    assertContains(content, 'registerKindleCommands', 'Missing kindle commands registration');
    assertContains(content, 'registerResearchCommands', 'Missing research commands registration');
});

test('Bright Data barrel exports Phase 2 components', () => {
    const indexPath = path.join(__dirname, '..', 'src', 'services', 'research', 'brightdata', 'index.ts');
    const content = fs.readFileSync(indexPath, 'utf8');
    assertContains(content, 'CDPClient', 'Missing CDPClient export');
    assertContains(content, 'ScrapingBrowser', 'Missing ScrapingBrowser export');
    assertContains(content, 'WebUnlocker', 'Missing WebUnlocker export');
});

test('Bright Data SERP adapter exists in adapters barrel', () => {
    const indexPath = path.join(__dirname, '..', 'src', 'services', 'research', 'adapters', 'index.ts');
    const content = fs.readFileSync(indexPath, 'utf8');
    assertContains(content, 'BrightDataSerpAdapter', 'Missing BrightDataSerpAdapter export');
});

test('Research orchestrator exports EscalationConsentFn', () => {
    const orchPath = path.join(__dirname, '..', 'src', 'services', 'research', 'researchOrchestrator.ts');
    const content = fs.readFileSync(orchPath, 'utf8');
    assertContains(content, 'EscalationConsentFn', 'Missing EscalationConsentFn type');
    assertContains(content, 'forceCleanup', 'Missing forceCleanup method');
});

test('ConfigurationService exports BasesTemplate', () => {
    const configPath = path.join(__dirname, '..', 'src', 'services', 'configurationService.ts');
    const content = fs.readFileSync(configPath, 'utf8');

    assertContains(content, 'export interface BasesTemplate', 'Missing BasesTemplate export');
});

test('ConfigurationService includes minutes personas', () => {
    const configPath = path.join(__dirname, '..', 'src', 'services', 'configurationService.ts');
    const content = fs.readFileSync(configPath, 'utf8');

    assertContains(content, 'minutes-personas.md', 'Missing minutes-personas config path');
    assertContains(content, 'DEFAULT_MINUTES_PERSONAS', 'Missing DEFAULT_MINUTES_PERSONAS');
});

test('Claude Web Search adapter exists in adapters barrel', () => {
    const indexPath = path.join(__dirname, '..', 'src', 'services', 'research', 'adapters', 'index.ts');
    const content = fs.readFileSync(indexPath, 'utf8');
    assertContains(content, 'ClaudeWebSearchAdapter', 'Missing ClaudeWebSearchAdapter export');
});

test('Claude Web Search types exported from researchTypes', () => {
    const typesPath = path.join(__dirname, '..', 'src', 'services', 'research', 'researchTypes.ts');
    const content = fs.readFileSync(typesPath, 'utf8');
    assertContains(content, 'ClaudeWebSearchResponse', 'Missing ClaudeWebSearchResponse type');
    assertContains(content, 'ClaudeWebSearchStreamCallbacks', 'Missing ClaudeWebSearchStreamCallbacks type');
    assertContains(content, 'ParsedCitation', 'Missing ParsedCitation type');
});

test('Claude Web Search settings have defaults', () => {
    const settingsPath = path.join(__dirname, '..', 'src', 'core', 'settings.ts');
    const content = fs.readFileSync(settingsPath, 'utf8');
    assertContains(content, 'researchClaudeMaxSearches', 'Missing researchClaudeMaxSearches default');
    assertContains(content, 'researchClaudeUseDynamicFiltering', 'Missing researchClaudeUseDynamicFiltering default');
});

test('Claude Web Search secret ID registered', () => {
    const secretPath = path.join(__dirname, '..', 'src', 'core', 'secretIds.ts');
    const content = fs.readFileSync(secretPath, 'utf8');
    assertContains(content, 'RESEARCH_CLAUDE_WEB_SEARCH_KEY', 'Missing RESEARCH_CLAUDE_WEB_SEARCH_KEY secret ID');
});

// ============================================
// Quick Peek integration checks
// ============================================

test('Quick Peek command registered in index', () => {
    const indexPath = path.join(__dirname, '..', 'src', 'commands', 'index.ts');
    const content = fs.readFileSync(indexPath, 'utf8');
    assertContains(content, 'registerQuickPeekCommands', 'Missing registerQuickPeekCommands in commands/index.ts');
});

test('Quick Peek settings have defaults', () => {
    const settingsPath = path.join(__dirname, '..', 'src', 'core', 'settings.ts');
    const content = fs.readFileSync(settingsPath, 'utf8');
    assertContains(content, 'quickPeekProvider', 'Missing quickPeekProvider default');
    assertContains(content, 'quickPeekModel', 'Missing quickPeekModel default');
});

test('Quick Peek source filter exported from embeddedContentDetector', () => {
    const detectorPath = path.join(__dirname, '..', 'src', 'utils', 'embeddedContentDetector.ts');
    const content = fs.readFileSync(detectorPath, 'utf8');
    assertContains(content, 'getQuickPeekSources', 'Missing getQuickPeekSources export');
});

// ============================================
// Audio Narration integration checks
// ============================================

test('Audio Narration command registered in index', () => {
    const indexPath = path.join(__dirname, '..', 'src', 'commands', 'index.ts');
    const content = fs.readFileSync(indexPath, 'utf8');
    assertContains(content, 'registerAudioNarrationCommands', 'Missing registerAudioNarrationCommands in commands/index.ts');
});

test('Audio Narration command id constant exported', () => {
    const cmdPath = path.join(__dirname, '..', 'src', 'commands', 'audioNarrationCommands.ts');
    const content = fs.readFileSync(cmdPath, 'utf8');
    assertContains(content, "NARRATE_NOTE_CMD_ID = 'narrate-note'", 'Missing NARRATE_NOTE_CMD_ID constant');
});

test('Audio Narration settings have defaults', () => {
    const settingsPath = path.join(__dirname, '..', 'src', 'core', 'settings.ts');
    const content = fs.readFileSync(settingsPath, 'utf8');
    assertContains(content, 'audioNarrationProvider', 'Missing audioNarrationProvider');
    assertContains(content, 'audioNarrationVoice', 'Missing audioNarrationVoice');
    assertContains(content, 'audioNarrationOutputFolder', 'Missing audioNarrationOutputFolder');
    assertContains(content, 'audioNarrationEmbedInNote', 'Missing audioNarrationEmbedInNote');
});

test('Audio Narration provider registry has Gemini entry', () => {
    const regPath = path.join(__dirname, '..', 'src', 'services', 'tts', 'ttsProviderRegistry.ts');
    const content = fs.readFileSync(regPath, 'utf8');
    assertContains(content, 'NARRATION_PROVIDERS', 'Missing NARRATION_PROVIDERS');
    assertContains(content, 'gemini-3.1-flash-tts-preview', 'Missing Gemini model id');
});

test('Audio Narration two-stage service exports prepareNarration + executeNarration', () => {
    const svcPath = path.join(__dirname, '..', 'src', 'services', 'audioNarration', 'audioNarrationService.ts');
    const content = fs.readFileSync(svcPath, 'utf8');
    assertContains(content, 'export async function prepareNarration', 'Missing prepareNarration');
    assertContains(content, 'export async function executeNarration', 'Missing executeNarration');
});

test('Audio Narration apiKeyHelpers wrapper exists', () => {
    const helpPath = path.join(__dirname, '..', 'src', 'services', 'apiKeyHelpers.ts');
    const content = fs.readFileSync(helpPath, 'utf8');
    assertContains(content, 'getAudioNarrationProviderConfig', 'Missing getAudioNarrationProviderConfig');
});

test('Audio Narration i18n strings present in en.ts', () => {
    const enPath = path.join(__dirname, '..', 'src', 'i18n', 'en.ts');
    const content = fs.readFileSync(enPath, 'utf8');
    assertContains(content, 'audioNarration:', 'Missing audioNarration namespace in en.ts');
    assertContains(content, 'narrateNote:', 'Missing commands.narrateNote in en.ts');
    assertContains(content, 'costConfirm:', 'Missing modals.costConfirm in en.ts');
});


// ============================================
// SUMMARY
// ============================================
console.log('\n' + '='.repeat(50));
console.log('TEST SUMMARY');
console.log('='.repeat(50));
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total:  ${passed + failed}`);

if (failures.length > 0) {
    console.log('\nFailed tests:');
    failures.forEach(f => {
        console.log(`  - ${f.name}: ${f.error}`);
    });
    process.exit(1);
} else {
    console.log('\n✓ All tests passed!');
    process.exit(0);
}
