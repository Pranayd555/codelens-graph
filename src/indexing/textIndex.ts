import * as fs from 'fs';
import { GraphDB, FileLine } from '../graph/graphDB';

export interface TextEntry {
  filePath: string;
  line: number;
  text: string;           // normalized lowercase
  rawText: string;        // original
  tokenType: 'symbol' | 'string_literal' | 'comment' | 'identifier' | 'unknown';
}

export class TextIndex {
  constructor(private db: GraphDB) {}

  async buildForFile(filePath: string, language: string): Promise<void> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      const fileLines: FileLine[] = [];
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        
        // Skip empty lines
        if (!trimmed) continue;
        
        // Classify the line
        const tokenType = this.classifyLine(line, language);
        
        fileLines.push({
          filePath,
          line: i + 1,
          rawText: trimmed,
          tokenType,
        });
      }

      // Clear old entries for this file and insert new ones
      this.db.deleteFileLinesByFile(filePath);
      if (fileLines.length > 0) {
        this.db.addFileLines(fileLines);
      }
    } catch (err) {
      console.warn(`[CodeLens] Failed to build text index for ${filePath}:`, err);
    }
  }
  
  private classifyLine(line: string, _language: string): TextEntry['tokenType'] {
    const trimmed = line.trim();
    
    // Comments
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('#')) {
      return 'comment';
    }
    
    // String literals (simple heuristic)
    if ((trimmed.includes('"') || trimmed.includes("'") || trimmed.includes('`')) && 
        !trimmed.includes('function') && !trimmed.includes('class') && !trimmed.includes('const')) {
      return 'string_literal';
    }
    
    // Symbol definitions (rough heuristic)
    if (/^\s*(function|class|const|let|var|interface|type|enum|export)\s/.test(trimmed)) {
      return 'symbol';
    }
    
    // Identifiers / assignments
    if (/^\s*[a-zA-Z_][a-zA-Z0-9_]*\s*[=:]/.test(trimmed)) {
      return 'identifier';
    }
    
    return 'unknown';
  }
  
  // ─── Search API ─────────────────────────────────────────────────────────
  
  search(query: string, options: {
    limit?: number;
    fileFilter?: string;      // e.g., '.ts'
    tokenType?: TextEntry['tokenType'];
    fuzzy?: boolean;         // allow partial matches
  } = {}): TextEntry[] {
    const { limit = 20, fileFilter, tokenType } = options;
    
    const dbResults = this.db.searchFileLines(
      query,
      fileFilter,
      tokenType === 'comment',
      tokenType === 'string_literal',
      limit
    );

    return dbResults.map(r => ({
      filePath: r.filePath,
      line: r.line,
      text: r.rawText.toLowerCase(),
      rawText: r.rawText,
      tokenType: r.type as any,
    }));
  }
}
