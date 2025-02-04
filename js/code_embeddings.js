const fs = require('graceful-fs');
const pathModule = require('path');
const CryptoJS = require('crypto-js');
const { RecursiveCharacterTextSplitter } = require('langchain/text_splitter');
const { OpenAIEmbeddings } = require('langchain/embeddings/openai');
const { MemoryVectorStore } = require('langchain/vectorstores/memory');
const detect = require('language-detect');
const { isTextFile } = require('./utils');

const EMBEDDINGS_VERSION = 'v3';

const detectedLanguageToSplitterMapping = {
  'C++': 'cpp',
  Go: 'go',
  Java: 'java',
  JavaScript: 'js',
  PHP: 'php',
  'Protocol Buffers': 'proto',
  Python: 'python',
  reStructuredText: 'rst',
  Ruby: 'ruby',
  Rust: 'rust',
  Scala: 'scala',
  Swift: 'swift',
  Markdown: 'markdown',
  LaTeX: 'latex',
  HTML: 'html',
  Solidity: 'sol',
};

class CodeEmbeddings {
  constructor(projectName, openAIApiKey) {
    this.projectName = projectName;
    this.openAIApiKey = openAIApiKey;
    this.vectorStore = new MemoryVectorStore(
      new OpenAIEmbeddings({
        openAIApiKey,
        modelName: 'text-embedding-ada-002',
        maxRetries: 3,
        timeout: 60 * 1000,
      }),
    );
  }

  async splitCodeIntoChunks(metadata, fileContent, language) {
    let splitter;
    if (!language || language === 'other') {
      splitter = new RecursiveCharacterTextSplitter({
        chunkSize: 1000,
        chunkOverlap: 0,
        keepSeparator: true,
      });
    } else {
      splitter = RecursiveCharacterTextSplitter.fromLanguage(language, {
        chunkSize: 1000,
        chunkOverlap: 0,
        keepSeparator: true,
      });
    }
    const documents = await splitter.createDocuments([fileContent], [metadata], {
      chunkHeader: `File name: ${metadata.filePath}\n---\n\n`,
      appendChunkOverlapHeader: true,
    });
    return documents;
  }

  async updateEmbeddingsForFiles(filesList) {
    if (!this.openAIApiKey) return;

    const promises = filesList.map((file) => this.updateEmbedding(file));
    await Promise.all(promises);
    this.deleteEmbeddingsForFilesNotInList(filesList);
    this.save();
  }

  async updateEmbedding(filePath) {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    if (!isTextFile(fileContent)) {
      return;
    }
    const hash = CryptoJS.SHA256(fileContent).toString() + EMBEDDINGS_VERSION;
    const fileRecords = this.findRecords(filePath);

    if (fileRecords.length > 0) {
      if (fileRecords[0].metadata.hash === hash) {
        return;
      } else {
        this.deleteRecords(filePath);
      }
    }

    const metadata = {
      filePath,
      hash,
    };

    let language;
    try {
      language = detect.sync(filePath);
    } catch (error) {
      // ignore
    }

    const mappedLanguage = detectedLanguageToSplitterMapping[language] || 'other';
    const documents = await this.splitCodeIntoChunks(metadata, fileContent, mappedLanguage);
    if (documents && documents.length > 0) {
      await this.vectorStore.addDocuments(documents);
    }
  }

  isEmbededAndCurrent(filePath, hash) {
    const records = this.findRecords(filePath);
    if (records.length === 0) return false;

    return records[0].metadata.hash === hash;
  }

  deleteEmbeddingsForFilesNotInList(filesList) {
    const filePathsToKeep = new Set(filesList);
    this.vectorStore.memoryVectors = this.vectorStore.memoryVectors.filter((record) => filePathsToKeep.has(record.metadata.filePath));
  }

  findRecords(filePath) {
    return this.vectorStore.memoryVectors.filter((record) => record.metadata.filePath === filePath);
  }

  deleteRecords(filePath) {
    this.vectorStore.memoryVectors = this.vectorStore.memoryVectors.filter((record) => record.metadata.filePath !== filePath);
  }

  async search({ query, limit = 50, basePath, minScore = 0.5, rerank = true }) {
    const results = await this.vectorStore.similaritySearchWithScore(query, limit * 2);
    if (!results) return [];

    const filteredResults = results.filter((result) => {
      const [record, score] = result;
      return score >= minScore && record.pageContent.length > 5;
    });
    const formattedResults = filteredResults.map((result) => {
      const [record, _score] = result;
      return {
        filePath: pathModule.relative(basePath, record.metadata.filePath),
        fileContent: record.pageContent,
        lines: record.metadata.loc.lines,
      };
    });

    if (!rerank) {
      return formattedResults.slice(0, limit);
    }

    const rerankedResults = await this.rerankSearchResults(query, formattedResults, limit);
    if (rerankedResults && rerankedResults.length > 0) {
      return rerankedResults.slice(0, limit);
    }

    return formattedResults.slice(0, limit);
  }

  async rerankSearchResults(query, searchResults, limit) {
    try {
      const searchResultsWithIndex = searchResults.map((result, index) => {
        return { index: index, filePath: result.filePath, fileContent: result.fileContent };
      });

      const prompt = `I am making some code changes and I am searching project codebase for relevant code for this functionality, here is the search query: ${query}\n
Search engine search results are:

${JSON.stringify(searchResultsWithIndex)}

What array indexes of these search result objects in JSON array above are the most relevant code snippets to my search query?
Respond with JSON array only with actual array indexes in the order of relevance, drop irrelevant results. Return array with ${limit} relevant indexes.}`;
      const format = [3, 1, 4];

      const parsedRankings = await chatController.backgroundTask.run({ prompt, format });
      const rankedResults = parsedRankings.filter((index) => index in searchResults).map((index) => searchResults[index]);
      return rankedResults;
    } catch (error) {
      return searchResults;
    }
  }

  save() {
    settings.set(`project.${this.projectName}.embeddings`, JSON.stringify(this.vectorStore.memoryVectors));
  }

  async load() {
    const serializedVectors = settings.get(`project.${this.projectName}.embeddings`);
    if (!serializedVectors) return;

    const vectors = JSON.parse(serializedVectors);
    this.vectorStore.memoryVectors = vectors;
  }
}

module.exports = CodeEmbeddings;
