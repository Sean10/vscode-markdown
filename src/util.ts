'use strict'

import * as fs from 'fs';
import { commands, Position, Range, TextDocument, TextEditor, Uri, workspace } from 'vscode';
import localize from './localize';
import { mdEngine } from './markdownEngine';
import { decodeHTML } from 'entities';

/* ┌────────┐
   │ Others │
   └────────┘ */

/** Scheme `File` or `Untitled` */
export const mdDocSelector = [{ language: 'markdown', scheme: 'file' }, { language: 'markdown', scheme: 'untitled' }];

export function isMdEditor(editor: TextEditor) {
    return editor && editor.document && editor.document.languageId === 'markdown';
}

export const REGEX_FENCED_CODE_BLOCK = /^( {0,3}|\t)```[^`\r\n]*$[\w\W]+?^( {0,3}|\t)``` *$/gm;

export function isInFencedCodeBlock(doc: TextDocument, lineNum: number): boolean {
    let textBefore = doc.getText(new Range(new Position(0, 0), new Position(lineNum, 0)));
    textBefore = textBefore.replace(REGEX_FENCED_CODE_BLOCK, '').replace(/<!--[\W\w]+?-->/g, '');
    //// So far `textBefore` should contain no valid fenced code block or comment
    return /^( {0,3}|\t)```[^`\r\n]*$[\w\W]*$/gm.test(textBefore);
}

export function mathEnvCheck(doc: TextDocument, pos: Position): string {
    const lineTextBefore = doc.lineAt(pos.line).text.substring(0, pos.character);
    const lineTextAfter = doc.lineAt(pos.line).text.substring(pos.character);

    if (
        /(^|[^\$])\$(|[^ \$].*)\\\w*$/.test(lineTextBefore)
        && lineTextAfter.includes('$')
    ) {
        // Inline math
        return "inline";
    } else {
        const textBefore = doc.getText(new Range(new Position(0, 0), pos));
        const textAfter = doc.getText().substr(doc.offsetAt(pos));
        let matches;
        if (
            (matches = textBefore.match(/\$\$/g)) !== null
            && matches.length % 2 !== 0
            && textAfter.includes('\$\$')
        ) {
            // $$ ... $$
            return "display";
        } else {
            return "";
        }
    }
}

let fileSizesCache = {}
export function isFileTooLarge(document: TextDocument): boolean {
    const sizeLimit = workspace.getConfiguration('markdown.extension.syntax').get<number>('decorationFileSizeLimit');
    const filePath = document.uri.fsPath;
    if (!filePath || !fs.existsSync(filePath)) {
        return false;
    }
    const version = document.version;
    if (fileSizesCache.hasOwnProperty(filePath) && fileSizesCache[filePath][0] === version) {
        return fileSizesCache[filePath][1];
    } else {
        const isTooLarge = fs.statSync(filePath)['size'] > sizeLimit;
        fileSizesCache[filePath] = [version, isTooLarge];
        return isTooLarge;
    }
}

/* ┌───────────┐
   │ Changelog │
   └───────────┘ */

export function getNewFeatureMsg(version: string) {
    switch (version) {
        case '1.3.0':
            return localize("1.3.0 msg");
        case '1.4.0':
            return localize("1.4.0 msg");
        case '1.5.0':
            return localize("1.5.0 msg");
        case '2.1.0':
            return localize("2.1.0 msg");
        case '2.4.0':
            return localize("2.4.0 msg");
        case '3.0.0':
            return localize("3.0.0 msg");
    }
    return undefined;
}

export function showChangelog() {
    commands.executeCommand('vscode.open', Uri.parse('https://github.com/yzhang-gh/vscode-markdown/blob/master/CHANGELOG.md'));
}

/* ┌─────────────────┐
   │ Text Extraction │
   └─────────────────┘ */

/**
 * Convert Markdown to plain text.
 * Remove Markdown syntax (bold, italic, links etc.) in a heading.
 * This function is only used before the `slugify` function.
 *
 * A Markdown heading may contain Markdown styles, e.g. `_italic_`.
 * It can also have HTML tags, e.g. `<code>`.
 * They should not be passed to the `slugify` function.
 *
 * The keys are modes, sometimes the same name as slugify modes.
 * The values are corresponding conversion methods, whose signature must be `(text: string) => string`.
 *
 * @param text A Markdown heading
 */
const mdHeadingToPlaintext = {
    /**
     * What this function actually does:
     * 1. (Escape syntax like `1.`)
     * 2. `md.render(text)`
     * 3. `getTextInHtml(text)`
     * 4. (Unescape)
     */
    "legacy": (text: string): string => {
        //// Issue #515
        text = text.replace(/\[([^\]]*)\]\[[^\]]*\]/, (_, g1) => g1);
        //// Escape leading `1.` and `1)` (#567, #585)
        text = text.replace(/^([\d]+)(\.)/, (_, g1) => g1 + '%dot%');
        text = text.replace(/^([\d]+)(\))/, (_, g1) => g1 + '%par%');
        //// Escape math environment
        text = text.replace(/\$/g, '%dollar%');

        if (!mdEngine.cacheMd) {
            return text;
        }

        const html = mdEngine.cacheMd.renderInline(text).replace(/\r?\n$/, '');
        text = getTextInHtml(html);

        //// Unescape
        text = text.replace('%dot%', '.');
        text = text.replace('%par%', ')');
        text = text.replace(/%dollar%/g, '$');
        return text;
    },

    /**
     * CommonMark-compliant.
     * Assuming the input string is in pure CommonMark.
     */
    "commonMark": (text: string): string => {
        // WIP
        return text;
    }
};

/**
 * Get plaintext from a HTML string
 *
 * 1. Convert HTML entities (#175, #575)
 * 2. Strip HTML tags (#179)
 *
 * @param html
 */
function getTextInHtml(html: string) {
    let text = html;
    //// remove <!-- HTML comments -->
    text = text.replace(/(<!--[^>]*?-->)/g, '');
    //// remove HTML tags
    while (/<(span|em|strong|a|p|code|kbd)[^>]*>(.*?)<\/\1>/.test(text)) {
        text = text.replace(/<(span|em|strong|a|p|code|kbd)[^>]*>(.*?)<\/\1>/g, (_, _g1, g2) => g2)
    }

    //// Decode HTML entities.
    text = decodeHTML(text);

    text = text.replace(/ +/g, ' ');
    return text;
}

/* ┌─────────┐
   │ Slugify │
   └─────────┘ */

// Converted from Ruby regular expression `/[^\p{Word}\- ]/u`
// `\p{Word}` => ASCII plus Letter (Ll/Lm/Lo/Lt/Lu), Mark (Mc/Me/Mn), Number (Nd/Nl/No), Connector_Punctuation (Pc)
/**
 * The definition of punctuation from GitHub and GitLab.
 */
const PUNCTUATION_REGEXP = /[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu;

export function slugify(heading: string, mode?: string, downcase?: boolean) {
    if (mode === undefined) {
        mode = workspace.getConfiguration('markdown.extension.toc').get<string>('slugifyMode');
    }
    if (downcase === undefined) {
        downcase = workspace.getConfiguration('markdown.extension.toc').get<boolean>('downcaseLink');
    }

    let slug = heading.trim();

    // Case conversion must be performed before calling slugify function.
    // Because some slugify functions encode strings in their own way.
    if (downcase) {
        slug = slug.toLowerCase()
    }

    // Sort by popularity.
    switch (mode) {
        case 'github':
            slug = slugifyMethods.github(slug);
            break;

        case 'gitlab':
            slug = slugifyMethods.gitlab(slug);
            break;

        case 'gitea':
            slug = slugifyMethods.gitea(slug);
            break;

        case 'vscode':
            slug = slugifyMethods.vscode(slug);
            break;

        default:
            slug = slugifyMethods.github(slug);
            break;
    }

    return slug;
}

/**
 * Slugify methods.
 *
 * The keys are slugify modes.
 * The values are corresponding slugify functions, whose signature must be `(slug: string) => string`.
 */
const slugifyMethods: { [mode: string]: (text: string) => string; } = {
    /**
     * GitHub slugify function
     */
    "github": (slug: string): string => {
        // <https://github.com/jch/html-pipeline/blob/master/lib/html/pipeline/toc_filter.rb>
        slug = mdHeadingToPlaintext.legacy(slug);
        slug = slug.replace(PUNCTUATION_REGEXP, '')
            // .replace(/[A-Z]/g, match => match.toLowerCase()) // only downcase ASCII region
            .replace(/ /g, '-');

        return slug;
    },

    /**
     * Gitea
     */
    "gitea": (slug: string): string => {
        // Gitea uses the blackfriday parser
        // https://godoc.org/github.com/russross/blackfriday#hdr-Sanitized_Anchor_Names
        slug = slug.replace(PUNCTUATION_REGEXP, '-')
            .replace(/ /g, '-')
            .replace(/_/g, '-')
            .split('-')
            .filter(Boolean)
            .join('-');

        return slug;
    },

    /**
     * GitLab
     */
    "gitlab": (slug: string): string => {
        // GitLab slugify function, translated to JS
        // <https://gitlab.com/gitlab-org/gitlab/blob/master/lib/banzai/filter/table_of_contents_filter.rb#L32>
        // Some bits from their other slugify function
        // <https://gitlab.com/gitlab-org/gitlab/blob/master/app/assets/javascripts/lib/utils/text_utility.js#L49>
        slug = slug.replace(PUNCTUATION_REGEXP, '')
            .replace(/ /g, '-')
            // Remove any duplicate separators or separator prefixes/suffixes
            .split('-')
            .filter(Boolean)
            .join('-')
            // digits-only hrefs conflict with issue refs
            .replace(/^(\d+)$/, 'anchor-$1');

        return slug;
    },

    /**
     * Visual Studio Code
     */
    "vscode": (slug: string): string => {
        // <https://github.com/Microsoft/vscode/blob/f5738efe91cb1d0089d3605a318d693e26e5d15c/extensions/markdown-language-features/src/slugify.ts#L22-L29>
        slug = encodeURI(
            slug.replace(/\s+/g, '-') // Replace whitespace with -
                .replace(/[\]\[\!\'\#\$\%\&\'\(\)\*\+\,\.\/\:\;\<\=\>\?\@\\\^\_\{\|\}\~\`。，、；：？！…—·ˉ¨‘’“”々～‖∶＂＇｀｜〃〔〕〈〉《》「」『』．〖〗【】（）［］｛｝]/g, '') // Remove known punctuators
                .replace(/^\-+/, '') // Remove leading -
                .replace(/\-+$/, '') // Remove trailing -
        );

        return slug;
    }
};
