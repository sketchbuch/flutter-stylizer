import { RelativePattern, window, workspace, WorkspaceFolder } from 'vscode';

const flutterStylizerAll = async (): Promise<void> => {
  const workspaceRoot: WorkspaceFolder = workspace.workspaceFolders![0];
  const dartFiles = await workspace.findFiles(new RelativePattern(workspaceRoot, '**/*.dart'), '**/node_modules/**');

  if (dartFiles.length < 1) {
    window.showInformationMessage('Flutter Stylizer: No dart files found within worksapce');
  } else {
    dartFiles.forEach((file, index: number) => {
      console.log('file', index, file);
    });
  }

  return Promise.resolve();
};

export default flutterStylizerAll;
