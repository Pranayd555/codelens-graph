import * as path from 'path';

// ─── Category definitions ─────────────────────────────────────────────────────
// Each category has path patterns and name patterns.
// A file matches a category if ANY pattern matches.

interface Category {
  label: string;
  pathPatterns:   RegExp[];
  namePatterns:   RegExp[];
}

const CATEGORIES: Category[] = [
  {
    label: 'API routes / controllers',
    pathPatterns: [/\/routes?\//i, /\/controllers?\//i, /\/handlers?\//i, /\/api\//i],
    namePatterns: [/router|routes?|controller|handler/i],
  },
  {
    label: 'Middleware',
    pathPatterns: [/\/middleware\//i, /\/middlewares\//i],
    namePatterns: [/middleware|guard|interceptor|pipe/i],
  },
  {
    label: 'Services / business logic',
    pathPatterns: [/\/services?\//i, /\/usecases?\//i, /\/domain\//i],
    namePatterns: [/service|usecase|manager/i],
  },
  {
    label: 'Data models / schemas',
    pathPatterns: [/\/models?\//i, /\/schemas?\//i, /\/entities?\//i, /\/db\//i],
    namePatterns: [/model|schema|entity|migration/i],
  },
  {
    label: 'Utility / helpers',
    pathPatterns: [/\/utils?\//i, /\/helpers?\//i, /\/lib\//i, /\/shared\//i],
    namePatterns: [/util|helper|common|shared/i],
  },
  {
    label: 'Configuration',
    pathPatterns: [/\/config\//i, /\/configs?\//i, /\/settings\//i],
    namePatterns: [/config|settings?|env|constants?/i],
  },
  {
    label: 'Frontend components',
    pathPatterns: [/\/components?\//i, /\/ui\//i, /\/views?\//i, /\/pages?\//i],
    namePatterns: [/component|widget|page|view/i],
  },
  {
    label: 'Template assets',
    pathPatterns: [/\/templates?\//i, /\/assets?\//i, /\/themes?\//i, /\/layouts?\//i],
    namePatterns: [/template|layout|theme|asset/i],
  },
  {
    label: 'Tests',
    pathPatterns: [/\/tests?\//i, /\/__tests__\//i, /\/spec\//i, /\/e2e\//i],
    namePatterns: [/\.test\.|\.spec\.|_test\.|_spec\./i],
  },
  {
    label: 'Scripts / CLI',
    pathPatterns: [/\/scripts?\//i, /\/cli\//i, /\/bin\//i, /\/tasks?\//i],
    namePatterns: [/script|migrate|seed|generate/i],
  },
  {
    label: 'Authentication / security',
    pathPatterns: [/\/auth\//i, /\/security\//i, /\/passport\//i],
    namePatterns: [/auth|passport|jwt|oauth|permission|role/i],
  },
];

// ─── FileClassifier ───────────────────────────────────────────────────────────

export class FileClassifier {

  // Assign a category label to a file path
  classify(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    const basename   = path.basename(normalized);

    for (const cat of CATEGORIES) {
      if (cat.pathPatterns.some(p => p.test(normalized))) { return cat.label; }
      if (cat.namePatterns.some(p => p.test(basename)))   { return cat.label; }
    }

    return 'Other';
  }

  // Group a list of file paths into a category map
  groupFiles(filePaths: string[]): Map<string, string[]> {
    const groups = new Map<string, string[]>();

    for (const fp of filePaths) {
      const label = this.classify(fp);
      if (!groups.has(label)) { groups.set(label, []); }
      groups.get(label)!.push(fp);
    }

    // Sort categories by size (most files first — most relevant to this project)
    return new Map(
      [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
    );
  }

  // Returns a compact string showing only categories relevant to a task
  buildCategoryHint(filePaths: string[], taskKeywords: string[]): string {
    const groups   = this.groupFiles(filePaths);
    const taskText = taskKeywords.join(' ').toLowerCase();
    const lines: string[] = [];

    for (const [label, files] of groups) {
      const labelL = label.toLowerCase();

      // Only show categories that are relevant to the task
      const relevant = taskKeywords.some(kw => labelL.includes(kw))
        || files.some(f => taskKeywords.some(kw => f.toLowerCase().includes(kw)));

      if (!relevant && lines.length > 0) { continue; } // skip irrelevant unless first

      const shown = files.slice(0, 4).map(f => path.basename(f)).join(', ');
      const extra = files.length > 4 ? ` +${files.length - 4} more` : '';
      lines.push(`**${label}** (${files.length}): ${shown}${extra}`);
    }

    // Always include at least 3 categories even if not matching
    if (lines.length < 3) {
      for (const [label, files] of groups) {
        if (lines.length >= 4) { break; }
        const entry = `**${label}** (${files.length}): ${files.slice(0,3).map(f => path.basename(f)).join(', ')}`;
        if (!lines.includes(entry)) { lines.push(entry); }
      }
    }

    return lines.join('\n');
  }
}
