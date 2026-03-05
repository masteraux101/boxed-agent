/**
 * soul-loader.js — Fetch & parse SOUL.md + Skill files from GitHub / Notion
 */

const SoulLoader = (() => {
  /* eslint-disable -- keeping original structure */
  const DEFAULT_CORS_PROXY = 'https://corsproxy.io/?url=';

  /**
   * Detect URL type
   */
  function detectSource(url) {
    if (!url) return 'unknown';
    if (
      url.includes('raw.githubusercontent.com') ||
      url.includes('gist.githubusercontent.com') ||
      url.includes('github.com')
    ) {
      return 'github';
    }
    if (url.includes('notion.so') || url.includes('notion.site')) {
      return 'notion-page';
    }
    return 'generic';
  }

  /**
   * Convert a GitHub blob URL to raw URL if needed
   * e.g. https://github.com/user/repo/blob/main/SOUL.md
   *   -> https://raw.githubusercontent.com/user/repo/main/SOUL.md
   */
  function toRawGitHubUrl(url) {
    const blobMatch = url.match(
      /github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)/
    );
    if (blobMatch) {
      return `https://raw.githubusercontent.com/${blobMatch[1]}/${blobMatch[2]}/${blobMatch[3]}`;
    }
    return url;
  }

  /**
   * Extract Notion page ID from URL
   */
  function extractNotionPageId(url) {
    // Pattern: notion.so/pagename-<32hex> or notion.site/pagename-<32hex>
    const match = url.match(/([a-f0-9]{32})\s*$/i);
    if (match) return match[1];
    // Hyphenated UUID
    const uuidMatch = url.match(
      /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i
    );
    if (uuidMatch) return uuidMatch[1].replace(/-/g, '');
    return null;
  }

  /**
   * Fetch raw text from a URL (GitHub raw, generic, etc.)
   */
  async function fetchRawText(url) {
    const resolved = toRawGitHubUrl(url.trim());
    const resp = await fetch(resolved);
    if (!resp.ok)
      throw new Error(`Failed to fetch ${resolved}: ${resp.status}`);
    return resp.text();
  }

  /**
   * Fetch content from Notion page via API (through CORS proxy)
   */
  async function fetchNotionContent(url, notionToken, corsProxy) {
    const pageId = extractNotionPageId(url);
    if (!pageId) throw new Error('Cannot extract Notion page ID from URL');

    const proxy = corsProxy || DEFAULT_CORS_PROXY;
    const apiUrl = `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`;
    const proxyUrl = `${proxy}${encodeURIComponent(apiUrl)}`;

    const headers = {
      'Notion-Version': '2022-06-28',
    };
    if (notionToken) {
      headers['Authorization'] = `Bearer ${notionToken}`;
    }

    const resp = await fetch(proxyUrl, { headers });
    if (!resp.ok)
      throw new Error(`Notion API error: ${resp.status} ${resp.statusText}`);

    const data = await resp.json();
    return notionBlocksToMarkdown(data.results || []);
  }

  /**
   * Convert Notion API blocks to Markdown text
   */
  function notionBlocksToMarkdown(blocks) {
    const lines = [];
    for (const block of blocks) {
      const type = block.type;
      const content = block[type];
      if (!content) continue;

      const text = richTextToString(content.rich_text || []);

      switch (type) {
        case 'heading_1':
          lines.push(`# ${text}`);
          break;
        case 'heading_2':
          lines.push(`## ${text}`);
          break;
        case 'heading_3':
          lines.push(`### ${text}`);
          break;
        case 'paragraph':
          lines.push(text);
          break;
        case 'bulleted_list_item':
          lines.push(`- ${text}`);
          break;
        case 'numbered_list_item':
          lines.push(`1. ${text}`);
          break;
        case 'code':
          lines.push(
            `\`\`\`${content.language || ''}\n${text}\n\`\`\``
          );
          break;
        case 'quote':
          lines.push(`> ${text}`);
          break;
        case 'divider':
          lines.push('---');
          break;
        case 'toggle':
          lines.push(`<details><summary>${text}</summary></details>`);
          break;
        default:
          if (text) lines.push(text);
      }
    }
    return lines.join('\n\n');
  }

  /**
   * Convert Notion rich_text array to plain string
   */
  function richTextToString(richTextArr) {
    return richTextArr
      .map((rt) => {
        let t = rt.plain_text || '';
        if (rt.annotations) {
          if (rt.annotations.bold) t = `**${t}**`;
          if (rt.annotations.italic) t = `*${t}*`;
          if (rt.annotations.code) t = `\`${t}\``;
          if (rt.annotations.strikethrough) t = `~~${t}~~`;
        }
        return t;
      })
      .join('');
  }

  /**
   * Parse frontmatter from a Skill file
   * Returns { meta: {name, description}, content: string }
   */
  function parseSkillFile(raw) {
    const meta = { name: 'Untitled Skill', description: '' };
    let content = raw;

    // Check for --- frontmatter ---
    const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (fmMatch) {
      const fmBlock = fmMatch[1];
      content = fmMatch[2];

      const nameMatch = fmBlock.match(/^name:\s*(.+)$/m);
      if (nameMatch) meta.name = nameMatch[1].trim().replace(/^["']|["']$/g, '');

      const descMatch = fmBlock.match(/^description:\s*(.+)$/m);
      if (descMatch)
        meta.description = descMatch[1].trim().replace(/^["']|["']$/g, '');
    }

    return { meta, content: content.trim() };
  }

  /**
   * Extract SOUL name from the first # heading
   */
  function extractSoulName(markdown) {
    const match = markdown.match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : 'Unnamed Soul';
  }

  /**
   * Main loader: fetches SOUL + Skills, returns assembled system instruction
   * @param {Object} config
   * @param {string} config.soulUrl
   * @param {string[]} config.skillUrls
   * @param {string} [config.notionToken]
   * @param {string} [config.corsProxy]
   * @returns {Promise<{systemInstruction: string, soulName: string, skills: Array}>}
   */
  async function load(config) {
    const { soulUrl, skillUrls = [], notionToken, corsProxy } = config;

    let soulContent = '';
    let soulName = 'Default';

    // Load SOUL
    if (soulUrl) {
      const source = detectSource(soulUrl);
      if (source === 'notion-page') {
        soulContent = await fetchNotionContent(
          soulUrl,
          notionToken,
          corsProxy
        );
      } else {
        soulContent = await fetchRawText(soulUrl);
      }
      soulName = extractSoulName(soulContent);
    }

    // Load Skills in parallel
    const skillResults = await Promise.allSettled(
      skillUrls
        .filter((u) => u.trim())
        .map(async (url) => {
          const source = detectSource(url);
          let raw;
          if (source === 'notion-page') {
            raw = await fetchNotionContent(url, notionToken, corsProxy);
          } else {
            raw = await fetchRawText(url);
          }
          return parseSkillFile(raw);
        })
    );

    const skills = [];
    const skillErrors = [];
    for (let i = 0; i < skillResults.length; i++) {
      if (skillResults[i].status === 'fulfilled') {
        skills.push(skillResults[i].value);
      } else {
        skillErrors.push({
          url: skillUrls[i],
          error: skillResults[i].reason.message,
        });
      }
    }

    // Assemble system instruction
    const parts = [];
    if (soulContent) {
      parts.push(`=== SOUL ===\n\n${soulContent}`);
    }
    for (const skill of skills) {
      parts.push(
        `=== SKILL: ${skill.meta.name} ===\n\n${skill.content}`
      );
    }

    return {
      systemInstruction: parts.join('\n\n---\n\n'),
      soulName,
      soulContent,
      skills,
      skillErrors,
    };
  }

  return {
    load,
    detectSource,
    extractSoulName,
    parseSkillFile,
    fetchRawText,
    fetchNotionContent,
  };
})();

export default SoulLoader;
