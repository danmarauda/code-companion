const fs = require('graceful-fs');
const CryptoJS = require('crypto-js');
const pathModule = require('path');
const Store = require('electron-store');
const ignore = require('ignore');
const ccignoreTemplate = require('./static/ccignore_template');
const CodeEmbeddings = require('./code_embeddings');

const LARGE_FILE_SIZE = 100000;
const EMBEDDINGS_VERSION = 'v3';
const addInstructionsModal = new bootstrap.Modal(document.getElementById('addInstructionsModal'));

class ProjectHandler {
  constructor() {
    this.settings = new Store();
    this.getProjects();
    this.currentProject = null;
    this.filesList = [];
    this.traverseDirectory = this.traverseDirectory.bind(this);
  }

  openProject(path) {
    this.embeddings = null;
    this.currentProject = null;
    this.filesList = [];

    if (!fs.existsSync(path)) {
      chatController.chat.addFrontendMessage('error', `The path '${path}' does not exist.`);
      return;
    }

    let project = this.projects.find((project) => project.path === path);
    if (!project) {
      let projectName = pathModule.basename(path);
      if (this.projects.find((project) => project.name === projectName)) {
        let i = 1;
        while (this.projects.find((project) => project.name === `${projectName} (${i})`)) {
          i++;
        }
        projectName = `${projectName} (${i})`;
      }
      project = this.saveProject(projectName, path, '');
    } else {
      this.updateProject(project);
    }
    if (chatController.terminalSession.terminal) {
      chatController.terminalSession.navigateToDirectory(path);
    }
    this.currentProject = project;

    // for saved chats, need to check
    if (chatController.chat.isEmpty()) {
      chatController.clearChat();
      chatController.chat.addFrontendMessage('assistant', `Hello! How can I assist you today?`);
    }
  }

  getProjects() {
    this.projects = [];
    const projects = this.settings.get('projects', []);
    projects.forEach((project) => {
      if (fs.existsSync(pathModule.normalize(project.path))) {
        this.projects.push(project);
      } else {
        settings.set(`project.${project.name}.embeddings`, '[]');
      }
    });
    this.projects = this.projects.sort((a, b) => new Date(b.lastOpened) - new Date(a.lastOpened));
    this.settings.set('projects', this.projects);
    return this.projects;
  }

  saveProject(name, path, filesHash) {
    const project = { name, path, lastOpened: new Date(), filesHash };
    this.projects.push(project);
    this.settings.set('projects', this.projects);
    return project;
  }

  updateProject(project) {
    project.lastOpened = new Date();
    this.projects = this.projects.map((p) => (p.path === project.path ? project : p));
    this.settings.set('projects', this.projects);
  }

  updateListOfFiles() {
    this.filesList = [];
    const ignoreList = this.getIgnoreList(this.currentProject.path);
    this.traverseDirectory(this.currentProject.path, ignoreList);
  }

  showInstructionsModal(path) {
    let project = this.projects.find((project) => project.path === path);

    if (project) {
      addInstructionsModal.show();
      let instructions = this.settings.get(`project.${project.name}.instructions`, '');
      document.getElementById('customInstructions').value = instructions;
      this.instructionsProjectName = project.name;
    } else {
      renderSystemMessage('Project not found');
    }
  }

  saveInstructions() {
    const instructions = document.getElementById('customInstructions').value;
    this.settings.set(`project.${this.instructionsProjectName}.instructions`, instructions);
    renderSystemMessage('Instructions updated');
    addInstructionsModal.hide();
  }

  getCustomInstructions() {
    if (!this.currentProject) return;
    const instructions = this.settings.get(`project.${this.currentProject.name}.instructions`, '');
    return instructions ? '\n\n' + instructions : '';
  }

  async createEmbeddings() {
    const openAIApiKey = settings.get('apiKey');
    if (!openAIApiKey) {
      return;
    }

    if (!this.embeddings) {
      this.embeddings = new CodeEmbeddings(this.currentProject.name, openAIApiKey);
      await this.embeddings.load();
    }

    const filesHash = await this.getFilesHash();
    if (filesHash === this.currentProject.filesHash) {
      return;
    }

    const MAX_FILES_TO_EMBED = settings.get('maxFilesToEmbed') || 500;
    if (this.filesList.length > MAX_FILES_TO_EMBED) {
      console.error(`Too many files to index with vector embeddings. (${this.filesList.length})`);
      chatController.chat.addFrontendMessage(
        'error',
        `Too many files to index with vector embeddings.
        <br>Trying to index ${this.filesList.length} files:
        <code>
        ${this.countFiles()}
        </code>
        Exclude files that don't need to be indexed for search in <code>.ccignore</code> file and try again.
        Only first ${MAX_FILES_TO_EMBED} files will be indexed.
        `,
      );
      this.filesList = this.filesList.slice(0, MAX_FILES_TO_EMBED);
    }

    await this.embeddings.updateEmbeddingsForFiles(this.filesList);
    this.currentProject.filesHash = filesHash;
    this.updateProject(this.currentProject);
  }

  async searchEmbeddings({ query, count = 10, rerank = true }) {
    if (!this.currentProject) {
      chatController.chat.addFrontendMessage('error', `No project is open. To use search, open a project first.`);
      return;
    }

    await this.createEmbeddings();
    const results = this.embeddings.search({ query, limit: count, basePath: this.currentProject.path, rerank });
    return results;
  }

  getIgnoreList(path) {
    const gitignorePath = pathModule.join(path, '.gitignore');
    const ccignorePath = pathModule.join(path, '.ccignore');
    let ignoreList = [];
    let ccignoreList = [];
    if (fs.existsSync(gitignorePath)) {
      ignoreList = fs
        .readFileSync(gitignorePath, 'utf-8')
        .split('\n')
        .filter((line) => line.trim() !== '' && !line.startsWith('#'));
    }
    if (fs.existsSync(ccignorePath)) {
      ccignoreList = fs
        .readFileSync(ccignorePath, 'utf-8')
        .split('\n')
        .filter((line) => line.trim() !== '' && !line.startsWith('#'));
    } else {
      ccignoreList = ccignoreTemplate.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#'));
    }
    ignoreList = ignoreList.concat(ccignoreList);
    return ignore().add(ignoreList);
  }

  traverseDirectory(path, ignoreList) {
    let files;
    try {
      files = fs.readdirSync(path);
    } catch (err) {
      console.error(`Failed to read directory ${path}: ${err}`);
      return;
    }

    for (const file of files) {
      const filePath = pathModule.join(path, file);
      const relativePath = pathModule.relative(this.currentProject.path, filePath);

      if (ignoreList.ignores(relativePath)) {
        continue;
      }

      let stats;
      try {
        stats = fs.statSync(filePath);
      } catch (err) {
        console.error(`Failed to get stats for ${filePath}: ${err}`);
        continue;
      }

      if (stats.isDirectory()) {
        this.traverseDirectory(filePath, ignoreList);
      } else {
        if (!this.shouldSkipFile(filePath, stats)) {
          this.filesList.push(filePath);
        }
      }
    }
  }

  shouldSkipFile(filePath, stats) {
    if (stats.size > LARGE_FILE_SIZE || stats.size === 0) {
      return true;
    }
    return false;
  }

  countFiles() {
    const pathSeparator = isWindows ? '\\' : '/';
    const folderCount = {};

    this.filesList.forEach((file) => {
      const formattedFilePath = pathModule.relative(this.currentProject.path, file);
      const pathParts = formattedFilePath.split(pathSeparator);

      let folderPath = '';
      for (let i = 0; i < pathParts.length - 1; i++) {
        // Iterate through all folders in the path
        folderPath += (i > 0 ? pathSeparator : '') + pathParts[i];
        folderCount[folderPath] = (folderCount[folderPath] || 0) + 1;
      }
    });

    return Object.entries(folderCount)
      .sort((a, b) => b[1] - a[1]) // Sort by count
      .map(([folder, count]) => `${folder}${count > 1 ? ` (${count} files)` : ''}`)
      .join('<br>');
  }

  async getFileHash(filePath) {
    const fileBuffer = await fs.promises.readFile(filePath);
    return CryptoJS.SHA256(fileBuffer.toString()).toString() + EMBEDDINGS_VERSION;
  }

  async getFilesHash() {
    this.updateListOfFiles();
    const hashes = await Promise.all(this.filesList.map((filePath) => this.getFileHash(filePath)));
    return CryptoJS.SHA256(hashes.join('')).toString();
  }
}

module.exports = ProjectHandler;
