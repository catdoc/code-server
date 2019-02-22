import { Emitter, Event } from "@coder/events";
import { client as ideClient } from "@coder/ide/src/fill/client";
import { client } from "@coder/vscode/src/client";
import * as fs from "fs";
import * as path from "path";
import { $, addClass, append } from "vs/base/browser/dom";
import { HighlightedLabel } from "vs/base/browser/ui/highlightedlabel/highlightedLabel";
import { ObjectTree } from "vs/base/browser/ui/tree/objectTree";
import { ITreeElement, ITreeNode, ITreeRenderer, TreeFilterResult, TreeVisibility } from "vs/base/browser/ui/tree/tree";
import { KeyCode } from "vs/base/common/keyCodes";
import { URI } from "vs/base/common/uri";
import { getIconClasses } from "vs/editor/common/services/getIconClasses";
import { IModelService } from "vs/editor/common/services/modelService";
import { IModeService } from "vs/editor/common/services/modeService";
import { FileKind } from "vs/platform/files/common/files";
import "./dialog.scss";
import { IThemeService } from "vs/platform/theme/common/themeService";

declare var __non_webpack_require__: typeof require;

export enum DialogType {
	NewFolder,
	Save,
	Open,
}

export interface CommonDialogOptions {
	readonly title?: string;
	readonly defaultPath?: string;
	readonly buttonLabel?: string;
}

export interface OpenDialogOptions extends CommonDialogOptions {
	readonly properties: {
		readonly openFile: true;
		readonly openDirectory?: boolean;
		readonly showHiddenFiles?: boolean;
	} | {
		readonly openDirectory: true;
		readonly showHiddenFiles?: boolean;
		readonly openFile?: boolean;
	};
}

export interface SaveDialogOptions extends CommonDialogOptions {
	readonly type: DialogType.Save;
	readonly nameFieldLabel?: string;
}

export type DialogOptions = OpenDialogOptions | SaveDialogOptions;

export const showOpenDialog = (options: OpenDialogOptions): Promise<string> => {
	return new Promise<string>((resolve, reject): void => {
		const dialog = new Dialog(DialogType.Open, options);
		dialog.onSelect((e) => {
			dialog.dispose();
			resolve(e);
		});
		dialog.onError((e) => {
			dialog.dispose();
			reject(e);
		});
	});

};

interface DialogEntry {
	readonly fullPath: string;
	readonly name: string;
	readonly isDirectory: boolean;
	readonly size: number;
	readonly lastModified: string;
}

class Dialog {
	private _path: string | undefined;

	private static readonly UpperDirId = "..";

	private readonly filesNode: HTMLElement;
	private readonly pathNode: HTMLElement;

	private readonly entryList: ObjectTree<DialogEntry, string>;
	private readonly background: HTMLElement;
	private readonly root: HTMLElement;

	private readonly selectEmitter: Emitter<string>;
	private readonly errorEmitter: Emitter<Error>;

	public constructor(
		private readonly type: DialogType,
		private readonly options: DialogOptions,
	) {
		this.selectEmitter = new Emitter();
		this.errorEmitter = new Emitter();

		this.background = document.createElement("div");
		this.background.style.position = "absolute";
		this.background.style.top = "0";
		this.background.style.left = "0";
		this.background.style.bottom = "0";
		this.background.style.right = "0";
		this.background.style.zIndex = "5";
		this.background.style.display = "flex";
		this.background.style.alignItems = "center";
		this.background.style.justifyContent = "center";
		this.background.style.background = "rgba(0, 0, 0, 0.25)";

		this.root = document.createElement("div");
		this.root.style.width = "850px";
		this.root.style.height = "600px";
		this.background.appendChild(this.root);
		document.body.appendChild(this.background);
		this.root.classList.add("dialog");

		const setProperty = (vari: string, id: string): void => {
			const getColor = (id: string): string | undefined => {
				const ts = client.serviceCollection.get<IThemeService>(IThemeService) as IThemeService;
				const c = ts.getTheme().getColor(id);
				if (!c) {
					return;
				}

				return c.toString();
			};
			const c = getColor(id);
			if (c) {
				this.root.style.setProperty(vari, c);
			}
		};
		setProperty("--primary", "sideBar.background");
		setProperty("--list-active-selection-background", "list.activeSelectionBackground");
		setProperty("--list-active-selection-foreground", "list.activeSelectionForeground");
		setProperty("--list-hover-background", "list.hoverBackground");
		setProperty("--header-background", "sideBarSectionHeader.background");
		setProperty("--header-foreground", "sideBarSectionHeader.foreground");
		setProperty("--border", "panel.border");

		this.background.addEventListener("contextmenu", (event) => {
			event.preventDefault();
		});

		const titleNode = document.createElement("div");
		titleNode.classList.add("title");
		let title: string | undefined;
		switch (this.type) {
			// case DialogType.NewFolder:
			// 	title = "New Folder";
			// 	break;
			case DialogType.Open:
				title = "Open File";
				break;
			case DialogType.Save:
				title = "Save File";
				break;
			default:
				throw new Error("Uncased type");
		}
		titleNode.innerText = options.title || title;
		this.root.appendChild(titleNode);

		const navItems = document.createElement("div");
		navItems.classList.add("nav");

		this.pathNode = document.createElement("div");
		this.pathNode.classList.add("path");
		navItems.appendChild(this.pathNode);
		this.root.appendChild(navItems);

		const fileAreaNode = document.createElement("div");
		fileAreaNode.classList.add("file-area");
		fileAreaNode.classList.add("show-file-icons");

		const headingsNode = document.createElement("div");
		headingsNode.className = "headings dialog-grid";
		["Name", "Size", "Last Modified"].forEach(e => {
			const header = document.createElement("div");
			header.innerText = e;
			headingsNode.appendChild(header);
		});

		this.filesNode = document.createElement("div");
		this.filesNode.className = "files-list";
		fileAreaNode.appendChild(headingsNode);
		this.entryList = new ObjectTree<DialogEntry, string>(this.filesNode, {
			getHeight: (entry: DialogEntry): number => {
				return 20;
			},
			getTemplateId: (entry: DialogEntry): string => {
				return "dialog-entry";
			},
		}, [new DialogEntryRenderer()], {
				openController: {
					shouldOpen: (event): boolean => {
						return true;
					},
				},
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel: (element): string => {
						return element.name;
					},
					mightProducePrintableCharacter: (event): boolean => {
						if (event.ctrlKey || event.metaKey) {
							// ignore ctrl/cmd-combination but not shift/alt-combinatios
							return false;
						}
						// weak check for certain ranges. this is properly implemented in a subclass
						// with access to the KeyboardMapperFactory.
						if ((event.keyCode >= KeyCode.KEY_A && event.keyCode <= KeyCode.KEY_Z)
							|| (event.keyCode >= KeyCode.KEY_0 && event.keyCode <= KeyCode.KEY_9)
							|| event.keyCode === KeyCode.US_DOT || event.keyCode === KeyCode.US_SLASH || event.keyCode === KeyCode.US_MINUS) {
							return true;
						}

						return false;
					},
				},
				automaticKeyboardNavigation: true,
				enableKeyboardNavigation: true,
				multipleSelectionSupport: false,
				openOnSingleClick: false,
				filter: {
					filter: (): TreeFilterResult<string> => {
						// tslint:disable-next-line:no-any
						(<any>this.entryList)._options.simpleKeyboardNavigation = true;
						// tslint:disable-next-line:no-any
						const pat = (<any>this.entryList).typeFilterController.filter._pattern;

						return {
							data: pat,
							visibility: TreeVisibility.Visible,
						};
					},
				},
				filterOnType: true,
			});
		// tslint:disable-next-line:no-any
		(<any>this.entryList).focusNavigationFilter = (node: ITreeNode<DialogEntry, string>): boolean => {
			if (node.filterData) {
				return node.element.name.toLowerCase().startsWith(node.filterData.toLowerCase()!);
			}

			return false;
		};
		this.entryList.onDidOpen((event) => {
			const element = event.elements[0]!;
			if (!element) {
				const fv = this.filterValue;

				if (fv === Dialog.UpperDirId) {
					this.path = path.dirname(this._path!);
				}

				if (fv.startsWith("/")) {
					fs.stat(fv, (err, stats) => {
						if (err) {
							return;
						}

						if (stats.isDirectory()) {
							this.path = fv;
						}
					});
				}

				return;
			}
			if (element.isDirectory) {
				this.path = element.fullPath;
			} else {
				// Open
				this.selectEmitter.emit(element.fullPath);
			}
		});
		fileAreaNode.appendChild(this.entryList.getHTMLElement());
		this.root.appendChild(fileAreaNode);

		const buttonsNode = document.createElement("div");
		buttonsNode.className = "buttons";
		const cancelBtn = document.createElement("button");
		cancelBtn.innerText = "Cancel";
		cancelBtn.addEventListener("click", () => {
			this.errorEmitter.emit(new Error("Cancelled"));
		});
		buttonsNode.appendChild(cancelBtn);
		const confirmBtn = document.createElement("button");
		confirmBtn.innerText = "Confirm";
		confirmBtn.addEventListener("click", () => {
			if (this._path) {
				this.selectEmitter.emit(this._path);
			}
		});
		buttonsNode.appendChild(confirmBtn);
		this.root.appendChild(buttonsNode);
		this.entryList.layout();

		this.path = options.defaultPath || "/";
	}

	public get onSelect(): Event<string> {
		return this.selectEmitter.event;
	}

	public get onError(): Event<Error> {
		return this.errorEmitter.event;
	}

	public dispose(): void {
		this.selectEmitter.dispose();
		this.errorEmitter.dispose();
		this.entryList.dispose();
		this.background.remove();
	}

	private buildPath(): void {
		while (this.pathNode.lastChild) {
			this.pathNode.removeChild(this.pathNode.lastChild);
		}

		if (!this._path) {
			throw new Error("cannot build path node without valid path");
		}

		const pathParts = ["", ...this._path.split("/").filter((p) => p.length > 0)];

		for (let i = 0; i < pathParts.length; i++) {
			const pathPartNode = document.createElement("div");
			pathPartNode.classList.add("path-part");
			pathPartNode.innerText = pathParts[i].length > 0 ? pathParts[i] : "/";

			if (i === pathParts.length - 1) {
				pathPartNode.classList.add("active");
			}

			pathPartNode.addEventListener("click", () => {
				this.path = "/" + pathParts.slice(0, i + 1).join("/");
			});

			this.pathNode.appendChild(pathPartNode);
		}
	}

	private set path(directory: string) {
		const ts = Date.now();
		this.list(directory).then((value) => {
			this._path = directory;
			this.buildPath();

			while (this.filesNode.lastChild) {
				this.filesNode.removeChild(this.filesNode.lastChild);
			}

			const items = value.filter((v) => {
				if (v.name.startsWith(".")) {
					const props = (this.options as OpenDialogOptions).properties;
					if (props && props.showHiddenFiles) {
						return true;
					}

					return false;
				}

				return true;
			});

			this.entryList.setChildren(null, items.map((i: DialogEntry): ITreeElement<DialogEntry> => ({ element: i })));
			this.entryList.domFocus();
			this.entryList.setFocus([null]);
			// Clears the input on refresh
			// tslint:disable-next-line:no-any
			(<any>this.entryList).typeFilterController.onInput("");
		}).catch((ex) => {
			this.errorEmitter.emit(ex);
		});
	}

	private get filterValue(): string {
		// tslint:disable-next-line:no-any
		return (<any>this.entryList).typeFilterController.filter._pattern;
	}

	private async list(directory: string): Promise<ReadonlyArray<DialogEntry>> {
		return ideClient.evaluate((_helper, directory) => {
			const fs = __non_webpack_require__("fs") as typeof import("fs");
			const util = __non_webpack_require__("util") as typeof import("util");
			const path = __non_webpack_require__("path") as typeof import("path");

			return util.promisify(fs.readdir)(directory).then((paths) => {
				paths = paths.sort();

				return Promise.all(paths.map(p => util.promisify(fs.stat)(path.join(directory, p)))).then((stats) => {
					return {
						paths,
						stats,
					};
				});
			}).then(({ paths, stats }) => {
				return stats.map((stat, index): DialogEntry => {
					return {
						fullPath: path.join(directory, paths[index]),
						name: paths[index],
						isDirectory: stat.isDirectory(),
						lastModified: stat.mtime.toDateString(),
						size: stat.size,
					};
				});
			});
		}, directory);
	}
}

interface DialogEntryData {
	icon: HTMLElement;
	size: HTMLElement;
	lastModified: HTMLElement;
	label: HighlightedLabel;
}

class DialogEntryRenderer implements ITreeRenderer<DialogEntry, string, DialogEntryData> {
	public get templateId(): string {
		return "dialog-entry";
	}

	public renderTemplate(container: HTMLElement): DialogEntryData {
		addClass(container, "dialog-entry");
		addClass(container, "dialog-grid");

		const wrapper = append(container, $(".dialog-entry-info"));
		const icon: HTMLElement = append(wrapper, $("div"));
		const name = append(wrapper, $(".dialog-entry-name"));
		const label = new HighlightedLabel(name, false);
		append(container, wrapper);
		const size = append(container, $(".dialog-entry-size"));
		const mtime = append(container, $(".dialog-entry-mtime"));

		return {
			icon,
			size,
			lastModified: mtime,
			label,
		};
	}

	public renderElement(node: ITreeNode<DialogEntry, string>, index: number, templateData: DialogEntryData): void {
		templateData.icon.className = "dialog-entry-icon monaco-icon-label";
		const classes = getIconClasses(
			client.serviceCollection.get<IModelService>(IModelService) as IModelService,
			client.serviceCollection.get<IModeService>(IModeService) as IModeService,
			URI.file(node.element.name),
			node.element.isDirectory ? FileKind.FOLDER : FileKind.FILE,
		);
		templateData.icon.hidden = classes.length === 0;
		classes.forEach((c) => {
			try {
				templateData.icon.classList.add(c);
			} catch (ex) {
				// Nothin needed. Sometimes bad classes are given
			}
		});
		templateData.label.set(node.element.name, typeof node.filterData === "string" && node.element.name.toLowerCase().startsWith(node.filterData.toLowerCase()) ? [{
			start: 0,
			end: node.filterData.length,
		}] : []);
		templateData.size.innerText = node.element.size.toString();
		templateData.lastModified.innerText = node.element.lastModified;
	}

	public disposeTemplate(templateData: DialogEntryData): void {
		// throw new Error("Method not implemented.");
	}
}
