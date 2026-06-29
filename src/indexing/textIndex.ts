import * as fs from 'fs';
import { GraphDB } from '../graph/graphDB';

export interface TextEntry {
  filePath: string;
  line: number;
  text: string;           // normalized lowercase
  rawText: string;        // original
  tokenType: 'symbol' | 'string_literal' | 'comment' | 'identifier' | 'unknown';
}

export class TextIndex {
  private stopWords = new Set(['the', 'a', 'is', 'to', 'of', 'and', 'in']);

  constructor(private db: GraphDB) {}

  async buildForFile(filePath: string, language: string): Promise<void> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      const entries: Array<TextEntry & { word: string }> = [];
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const normalized = line.toLowerCase().trim();
        
        // Skip empty lines
        if (!normalized) continue;
        
        // Classify the line
        const tokenType = this.classifyLine(line, language);
        
        const entryBase = {
          filePath,
          line: i + 1,
          text: normalized,
          rawText: line.trim(),
          tokenType,
        };
        
        // Index every meaningful word
        const words = this.extractWords(normalized);
        for (const word of words) {
          entries.push({
            word,
            ...entryBase,
          });
        }
      }

      // Clear old entries for this file and insert new ones
      this.db.deleteTextEntriesByFile(filePath);
      if (entries.length > 0) {
        this.db.addTextEntries(entries);
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
  
  private extractWords(text: string): string[] {
    return text
      .replace(/[^a-z0-9_]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !this.stopWords.has(w));
  }
  
  // ─── Search API ─────────────────────────────────────────────────────────
  
  search(query: string, options: {
    limit?: number;
    fileFilter?: string;      // e.g., '.ts'
    tokenType?: TextEntry['tokenType'];
    fuzzy?: boolean;         // allow partial matches
  } = {}): TextEntry[] {
    const { limit = 20, fileFilter, tokenType, fuzzy = true } = options;
    const queryWords = this.extractWords(query.toLowerCase());
    
    if (!queryWords.length) return [];
    
    // Score-based ranking
    const scores = new Map<string, number>(); // entry key -> score
    const entries = new Map<string, TextEntry>();
    
    for (const word of queryWords) {
      const exactMatches = this.db.getTextEntriesByWord(word, true);
      
      for (const entry of exactMatches) {
        // Apply filters
        if (fileFilter && !entry.filePath.endsWith(fileFilter)) continue;
        if (tokenType && entry.tokenType !== tokenType) continue;
        
        const key = `${entry.filePath}:${entry.line}`;
        const currentScore = scores.get(key) || 0;
        
        // Score: +3 for exact word match
        scores.set(key, currentScore + 3);
        entries.set(key, entry);
      }
      
      // Fuzzy: prefix matches
      if (fuzzy) {
        const fuzzyMatches = this.db.getTextEntriesByWord(word, false);
        for (const entry of fuzzyMatches) {
          // Skip exact matches we already scored
          if (entry.word === word) continue;
          
          if (fileFilter && !entry.filePath.endsWith(fileFilter)) continue;
          if (tokenType && entry.tokenType !== tokenType) continue;
          
          const key = `${entry.filePath}:${entry.line}`;
          if (scores.has(key) && exactMatches.some(m => m.filePath === entry.filePath && m.line === entry.line)) {
            continue;
          }
          
          scores.set(key, (scores.get(key) || 0) + 1);
          entries.set(key, entry);
        }
      }
    }
    
    // Sort by score, return top entries
    const sorted = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([key]) => entries.get(key)!);
    
    return sorted;
  }
}
