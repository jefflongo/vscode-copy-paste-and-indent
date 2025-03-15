import * as vscode from 'vscode';

function getIndentation(input: string): string {
    return input.match(/^(\s*)/)?.[0] || "";
}

function getMinimumIndentation(lines: readonly string[]): number {
    let min: number | undefined = undefined;

    for (const line of lines) {
        const lineIsWhitespace = line.trim().length === 0;
        if (!lineIsWhitespace) {
            const indentation = getIndentation(line).length;
            if (min === undefined || indentation < min) {
                min = indentation;
            }
        }
    }

    return min ?? 0;
}

async function copy(cut: boolean = false) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }

    // get configuration
    const editorConfig = vscode.workspace.getConfiguration("editor");
    const emptySelectionClipboard = editorConfig.get<boolean>("emptySelectionClipboard", true);
    const eol = editor.document.eol === vscode.EndOfLine.LF ? "\n" : "\r\n";

    // selections are stored in the order in which they were created. 
    // reorder by line since this is the order in which things will be added to the clipboard.
    const selections = [...editor.selections].sort((a, b) => a.start.line - b.start.line);

    // get the lines across all selections and determine the minimum indentation
    const lines = selections.flatMap(selection => Array.from(
        { length: selection.end.line - selection.start.line + 1 },
        (_, i) => editor.document.lineAt(selection.start.line + i).text)
    );
    const minimumIndentation = getMinimumIndentation(lines);

    // get the text to be copied to the clipboard
    let toClipboard = selections.flatMap((selection) => {
        const copyWholeLine = emptySelectionClipboard && selection.isEmpty;

        // unindent each line and get the selected portion of each line
        const selectionLines: string[] = [];
        for (let lineIndex = selection.start.line; lineIndex <= selection.end.line; lineIndex++) {
            const isFirstLine = lineIndex === selection.start.line;
            const isLastLine = lineIndex === selection.end.line;
            const line = editor.document.lineAt(lineIndex).text;
            const unindentedLine = line.slice(minimumIndentation);
            let selectionLine = "";

            let start = 0;
            if (isFirstLine && !copyWholeLine && selection.start.character > minimumIndentation) {
                start = selection.start.character - minimumIndentation;

                // append any indentation that wasn't selected
                const textBeforeCursor = unindentedLine.slice(0, start);
                selectionLine += getIndentation(textBeforeCursor);
            }

            let end = unindentedLine.length;
            if (isLastLine && !copyWholeLine) {
                end = Math.max(selection.end.character - minimumIndentation, 0);
            }

            selectionLine += unindentedLine.slice(start, end);
            selectionLines.push(selectionLine);
        }
        return selectionLines;
    }).join(eol);

    // whole lines copied by empty selections always end in an EOL. this is handled for intermediary
    // whole lines due to selections being joined by EOL. however, there is no EOL after the last
    // selection. explicitly add it here if necessary.
    const lastSelection = selections.at(-1)!;
    if (emptySelectionClipboard && lastSelection.isEmpty) {
        toClipboard += eol;
    }

    // handle deletion if cutting
    if (cut) {
        await editor.edit(editBulider => {
            for (const selection of selections) {
                if (emptySelectionClipboard && selection.isEmpty) {
                    const lineToDelete = editor.document.lineAt(selection.start.line);
                    editBulider.delete(lineToDelete.rangeIncludingLineBreak);
                } else {
                    editBulider.delete(selection);
                }
            }
        });
    }

    await vscode.env.clipboard.writeText(toClipboard);
}

async function cut() {
    await copy(true);
}

async function paste() {
    const clipboardText = await vscode.env.clipboard.readText();
    if (!clipboardText) {
        return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }

    // get configuration
    const editorConfig = vscode.workspace.getConfiguration("editor");
    const multiCursorPaste = editorConfig.get<string>("multiCursorPaste", "spread");
    const formatOnPaste = editorConfig.get<boolean>("formatOnPaste", false);
    const eol = editor.document.eol === vscode.EndOfLine.LF ? "\n" : "\r\n";

    // selections are stored in the order in which they were created. 
    // reorder by line since this is the order in which things will be pasted if spreading.
    const selections = [...editor.selections].sort((a, b) => a.start.line - b.start.line);

    // determine the minimum indentation in the clipboard and unindent.
    // this step was performed in `copy`, but the text may have been copied externally.
    // therefore, make an attempt to unindent the copied text in this case, even though we don't
    // have the context to properly handle the first line.
    const lines = clipboardText.split(/\r\n|\r|\n/);
    const minimumIndentation = getMinimumIndentation(lines);
    const unindentedLines =
        minimumIndentation > 0 ? lines.map(line => line.slice(minimumIndentation)) : lines;

    // when a single line is in the clipboard containing a trailing EOL, and the selection to paste
    // in is empty, the paste is inserted at the beginning of the line.
    const clipboardIsSingleWholeLine = unindentedLines.length === 2 && unindentedLines[1] === "";

    // if the multiCursorPaste editor option is configured to "spread", and the number of copied
    // selections matches the number of selections to paste in, paste one copy selection per paste
    // selection.
    // NOTE: this mode is only partially supported. vscode stores clipboard metadata enabling
    // tracking of multiline text per selection. we cannot do this, so only one line is supported
    // per copy selection.
    const numLinesWithoutTrailingEOL =
        unindentedLines.at(-1)! !== "" ? unindentedLines.length : unindentedLines.length - 1;
    const spread =
        multiCursorPaste === "spread" &&
        selections.length > 1 &&
        selections.length === numLinesWithoutTrailingEOL;

    await editor.edit(editBuilder => {
        for (const [i, selection] of selections.entries()) {
            const pasteOnNewLine = clipboardIsSingleWholeLine && selection.isEmpty;

            const firstLine = editor.document.lineAt(selection.start.line).text;
            const textBeforeCursor = firstLine.slice(0, selection.start.character);
            const indentation = getIndentation(textBeforeCursor);

            if (pasteOnNewLine) {
                // single line empty selection paste mode:
                // indent the text and insert at the beginning of the line for each selection
                const indentedText = indentation + unindentedLines[0] + eol;
                editBuilder.insert(new vscode.Position(selection.start.line, 0), indentedText);
            } else if (spread) {
                // "spread" paste mode:
                // paste one line per selection, the line is already indented
                editBuilder.replace(selection, unindentedLines[i]);
            } else {
                // default paste mode:
                // indent the text, but not the first line because it's already indented
                // paste at every selection
                const indentedText = unindentedLines
                    .map((line, index) => index !== 0 ? indentation + line : line).join(eol);
                editBuilder.replace(selection, indentedText);
            }
        }
    });

    // if format on paste is enabled, do it now
    if (formatOnPaste) {
        await vscode.commands.executeCommand("editor.action.formatDocument");
    }
}

export function activate(context: vscode.ExtensionContext) {
    const disposables = [
        vscode.commands.registerCommand("copy-paste-and-indent.copy", copy),
        vscode.commands.registerCommand("copy-paste-and-indent.cut", cut),
        vscode.commands.registerCommand("copy-paste-and-indent.paste", paste),
    ];

    context.subscriptions.concat(disposables);
}

export function deactivate() { }
