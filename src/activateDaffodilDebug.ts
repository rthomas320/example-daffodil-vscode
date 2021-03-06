/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import * as hexView from './hexview/hexView';
import * as os from 'os';
import * as child_process from 'child_process';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import { DaffodilDebugSession } from './daffodilDebug';
import { getDebugger, getDataFileFromFolder } from './daffodilDebugger';
import { FileAccessor } from './daffodilRuntime';
import * as fs from 'fs';
import XDGAppPaths from 'xdg-app-paths';
const xdgAppPaths = XDGAppPaths({"name": "dapodil"});
import * as infoset from './infoset';
import { deactivate } from './extension';

// Function for stopping debuggin
function stopDebugging() {
	vscode.debug.stopDebugging();
	deactivate();
	vscode.window.activeTerminal?.processId.then(id => {
		if (id) {
			if (os.platform() === 'win32') {
				child_process.exec(`taskkill /F /PID ${id}`);
			}
			else {
				child_process.exec(`kill -9 ${id}`);
			}
		}
	});
}

// Function for setting up the commands for Run and Debug file
function createDebugRunFileConfigs(resource: vscode.Uri, runOrDebug: String) {

	let targetResource = resource;
	let noDebug = runOrDebug === "run" ? true : false;

	if (!targetResource && vscode.window.activeTextEditor) {
		targetResource = vscode.window.activeTextEditor.document.uri;
	}
	if (targetResource) {
		let infosetFile = `${path.basename(targetResource.fsPath).split(".")[0]}-infoset.xml`;

		vscode.debug.startDebugging(undefined, {
				type: 'dfdl',
				name: 'Run File',
				request: 'launch',
				program: targetResource.fsPath,
				data: "${command:AskForDataName}",
				debugServer: 4711,
				infosetOutput: {
					type: "file",
					path: infosetFile
				}
			},
			{ noDebug: noDebug }
		);

		vscode.debug.onDidTerminateDebugSession(async () => {
			if (!vscode.workspace.workspaceFolders) { return; }
			
			vscode.workspace.openTextDocument(`${vscode.workspace.workspaceFolders[0].uri.fsPath}/${infosetFile}`).then(doc => {
				vscode.window.showTextDocument(doc);
			});
		});
	}
}

export function activateDaffodilDebug(context: vscode.ExtensionContext, factory?: vscode.DebugAdapterDescriptorFactory) {
	context.subscriptions.push(
		vscode.commands.registerCommand('extension.dfdl-debug.runEditorContents', (resource: vscode.Uri) =>  {
			createDebugRunFileConfigs(resource, "run");
		}),
		vscode.commands.registerCommand('extension.dfdl-debug.debugEditorContents', (resource: vscode.Uri) => {
			createDebugRunFileConfigs(resource, "debug");
		}),
		vscode.commands.registerCommand('extension.dfdl-debug.toggleFormatting', (variable) => {
			const ds = vscode.debug.activeDebugSession;
			if (ds) {
				ds.customRequest('toggleFormatting');
			}
		})
	);

	context.subscriptions.push(vscode.commands.registerCommand('extension.dfdl-debug.getProgramName', async (config) => {
		// Open native file explorer to allow user to select data file from anywhere on their machine
		let programFile = await vscode.window.showOpenDialog({
            canSelectMany: false, openLabel: "Select DFDL schema to debug",
            canSelectFiles: true, canSelectFolders: false,
			title: "Select DFDL schema to debug"
        })
		.then(fileUri => {
			if (fileUri && fileUri[0]) {
				return fileUri[0].fsPath;
			}

			return "";
		});

		// Create file that holds path to program file used
		await fs.writeFile(`${xdgAppPaths.data()}/.programFile`, programFile, function(err){
			if (err) {
				vscode.window.showInformationMessage(`error code: ${err.code} - ${err.message}`);
			}
		});

		// If program file not selected stop launch
		if (programFile === "") {
			stopDebugging();
		}

		return programFile;
	}));

	context.subscriptions.push(vscode.commands.registerCommand('extension.dfdl-debug.getDataName', async (config) => {
		// If prgramFile is not set do not prompt for dataFile
		const programFile = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.parse(`${xdgAppPaths.data()}/.programFile`))).toString("utf8");
		if (programFile === "") {
			stopDebugging();
			return "";
		}

		// Open native file explorer to allow user to select data file from anywhere on their machine
		let dataFile = await vscode.window.showOpenDialog({
            canSelectMany: false, openLabel: "Select input data file to debug",
            canSelectFiles: true, canSelectFolders: false,
			title: "Select input data file to debug"
        })
		.then(fileUri => {
			if (fileUri && fileUri[0]) {
				return fileUri[0].fsPath;
			}

			return "";
		});

		// If data file not selected stop launch
		if (dataFile === "") {
			stopDebugging();
		}

		return dataFile;
	}));

	// register a configuration provider for 'dfdl' debug type
	const provider = new DaffodilConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('dfdl', provider));

	// register a dynamic configuration provider for 'dfdl' debug type
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('dfdl', {
		provideDebugConfigurations(folder: WorkspaceFolder | undefined): ProviderResult<DebugConfiguration[]> {
			if (!vscode.workspace.workspaceFolders) {
				return [
					{
						name: "Dynamic Launch",
						request: "launch",
						type: "dfdl",
						program: "${file}",
						data: "${command:AskForDataName}",
						debugServer: 4711,
						infosetOutput: {
							"type": "file",
							"path": "${file}-infoset.xml"
						}
					},
					{
						name: "Another Dynamic Launch",
						request: "launch",
						type: "dfdl",
						program: "${file}",
						data: "${command:AskForDataName}",
						debugServer: 4711,
						infosetOutput: {
							"type": "file",
							"path": "${file}-infoset.xml"
						}
					},
					{
						name: "Daffodil Launch",
						request: "launch",
						type: "dfdl",
						program: "${file}",
						data: "${command:AskForDataName}",
						debugServer: 4711,
						infosetOutput: {
							"type": "file",
							"path": "${file}-infoset.xml"
						}
					}
				];
			}

			let targetResource = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.uri : vscode.workspace.workspaceFolders[0].uri;
			let infosetFile = `${path.basename(targetResource.fsPath).split(".")[0]}-infoset.xml`;

			return [
				{
					name: "Dynamic Launch",
					request: "launch",
					type: "dfdl",
					program: "${file}",
					data: "${command:AskForDataName}",
					debugServer: 4711,
					infosetOutput: {
						type: "file",
						path: infosetFile
					}
				},
				{
					name: "Another Dynamic Launch",
					request: "launch",
					type: "dfdl",
					program: "${file}",
					data: "${command:AskForDataName}",
					debugServer: 4711,
					infosetOutput: {
						type: "file",
						path: infosetFile
					}
				},
				{
					name: "Daffodil Launch",
					request: "launch",
					type: "dfdl",
					program: "${file}",
					data: "${command:AskForDataName}",
					debugServer: 4711,
					infosetOutput: {
						type: "file",
						path: infosetFile
					}
				}
			];
		}
	}, vscode.DebugConfigurationProviderTriggerKind.Dynamic));

	if (!factory) {
		factory = new InlineDebugAdapterFactory(context);
	}
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('dfdl', factory));
	if ('dispose' in factory) {
		context.subscriptions.push(factory);
	}

	// override VS Code's default implementation of the debug hover
	context.subscriptions.push(vscode.languages.registerEvaluatableExpressionProvider('xml', {
		provideEvaluatableExpression(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.EvaluatableExpression> {
			const wordRange = document.getWordRangeAtPosition(position);
			return wordRange ? new vscode.EvaluatableExpression(wordRange) : undefined;
		}
	}));

	// override VS Code's default implementation of the "inline values" feature"
	context.subscriptions.push(vscode.languages.registerInlineValuesProvider('xml', {

		provideInlineValues(document: vscode.TextDocument, viewport: vscode.Range, context: vscode.InlineValueContext) : vscode.ProviderResult<vscode.InlineValue[]> {

			const allValues: vscode.InlineValue[] = [];

			for (let l = viewport.start.line; l <= context.stoppedLocation.end.line; l++) {
				const line = document.lineAt(l);
				var regExp = /local_[ifso]/ig;	// match variables of the form local_i, local_f, Local_i, LOCAL_S...
				do {
					var m = regExp.exec(line.text);
					if (m) {
						const varName = m[0];
						const varRange = new vscode.Range(l, m.index, l, m.index + varName.length);

						// value found via variable lookup
						allValues.push(new vscode.InlineValueVariableLookup(varRange, varName, false));
					}
				} while (m);
			}

			return allValues;
		}
	}));

	infoset.activate(context);
}

class DaffodilConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {

		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.languageId === 'xml') {
				config.type = 'dfdl';
				config.name = 'Launch';
				config.request = 'launch';
				config.program = '${file}';
				config.data = '${command:AskForDataName}';
				config.stopOnEntry = true;
				config.useExistingServer = false;
				config.infosetOutput = {
					"type": "file",
					"path": "${file}-infoset.xml"
				};
				config.debugServer = 4711;
			}
		}

		if (!config.program) {
			return vscode.window.showInformationMessage("Cannot find a program to debug").then(_ => {
				return undefined;	// abort launch
			});
		}

		let dataFolder = config.data;

		if (dataFolder.includes("${workspaceFolder}") && vscode.workspace.workspaceFolders && dataFolder.split(".").length === 1) {
			dataFolder = vscode.workspace.workspaceFolders[0].uri.fsPath;
		}

		if (!dataFolder.includes("${command:AskForProgramName}") && !dataFolder.includes("${command:AskForDataName}") && !dataFolder.includes("${workspaceFolder}") 
			&& dataFolder.split(".").length === 1 && fs.lstatSync(dataFolder).isDirectory()) 
		{
			return getDataFileFromFolder(dataFolder).then(dataFile => {
				config.data = dataFile;
				return getDebugger(config).then(result => {
					return config;
				});
			});
		}
		
		return getDebugger(config).then(result => {
			return config;
		});
	}
}

export const workspaceFileAccessor: FileAccessor = {
	async readFile(path: string) {
		try {
			const uri = vscode.Uri.file(path);
			const bytes = await vscode.workspace.fs.readFile(uri);
			const contents = Buffer.from(bytes).toString('utf8');
			return contents;
		} catch(e) {
			try {
				const uri = vscode.Uri.parse(path);
				const bytes = await vscode.workspace.fs.readFile(uri);
				const contents = Buffer.from(bytes).toString('utf8');
				return contents;
			} catch (e) {
				return `cannot read '${path}'`;
			}
		}
	}
};

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
	context: vscode.ExtensionContext;
	hexViewer: hexView.DebuggerHexView;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
		this.hexViewer = new hexView.DebuggerHexView(context);
	}

	createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
		return new vscode.DebugAdapterInlineImplementation(new DaffodilDebugSession(workspaceFileAccessor));
	}
}
