'use strict';
import * as vscode from 'vscode';

const commentRE = /^(.*?)\s*\/\/.*$/;

enum EntityType {
    Unknown,
    BlankLine,
    SingleLineComment,
    MultiLineComment,
    MainConstructor,
    NamedConstructor,
    StaticVariable,
    InstanceVariable,
    StaticPrivateVariable,
    PrivateInstanceVariable,
    OverrideMethod,
    OtherMethod,
    BuildMethod,
}

class DartLine {
    line: string;
    stripped: string;
    startOffset: number;
    endOffset: number;
    entityType: EntityType = EntityType.Unknown;

    constructor(line: string, startOffset: number) {
        this.line = line;
        this.startOffset = startOffset;
        this.endOffset = startOffset + line.length - 1;
        let m = commentRE.exec(line);
        this.stripped = (m ? m[1] : this.line).trim();
        if (this.stripped.length === 0) {
            this.entityType = (line.indexOf('//') >= 0) ?
                EntityType.SingleLineComment : EntityType.BlankLine;
        }
    }
}

// DartEntity represents a single, independent feature of a DartClass.
class DartEntity {
    entityType: EntityType = EntityType.Unknown;
    lines: Array<DartLine> = [];
    name: string = "";  // Used for sorting, but could be "".
}

class DartClass {
    editor: vscode.TextEditor;
    className: string;
    classOffset: number;
    openCurlyOffset: number;
    closeCurlyOffset: number;
    fullBuf: string = "";
    lines: Array<DartLine> = [];  // Line 0 is always the open curly brace.
    theConstructor?: DartEntity = undefined;
    namedConstructors: Array<DartEntity> = [];
    staticVariables: Array<DartEntity> = [];
    instanceVariables: Array<DartEntity> = [];
    staticPrivateVariables: Array<DartEntity> = [];
    privateVariables: Array<DartEntity> = [];
    overrideMethods: Array<DartEntity> = [];
    otherMethods: Array<DartEntity> = [];
    buildMethod?: DartEntity = undefined;

    constructor(editor: vscode.TextEditor, className: string, classOffset: number, openCurlyOffset: number, closeCurlyOffset: number) {
        this.editor = editor;
        this.className = className;
        this.classOffset = classOffset;
        this.openCurlyOffset = openCurlyOffset;
        this.closeCurlyOffset = closeCurlyOffset;
        const lessThanOffset = className.indexOf('<');
        if (lessThanOffset >= 0) {  // Strip off <T>.
            this.className = className.substring(0, lessThanOffset);
        }
    }

    async findFeatures(buf: string) {
        this.fullBuf = buf;
        let lines = this.fullBuf.split('\n');
        let lineOffset = 0;
        lines.forEach((line) => {
            this.lines.push(new DartLine(line, lineOffset));
            lineOffset += line.length;
            // Change a blank line following a comment to a SingleLineComment in
            // order to keep it with the following entity.
            const numLines = this.lines.length;
            if (numLines > 1 &&
                this.lines[numLines - 1].entityType === EntityType.BlankLine &&
                isComment(this.lines[numLines - 2])) {
                this.lines[numLines - 1].entityType = EntityType.SingleLineComment;
            }
        });

        this.identifyMultiLineComments();
        await this.identifyMainConstructor();
        await this.identifyNamedConstructors();
        await this.identifyOverrideMethods();
        await this.identifyOthers();

        // this.lines.forEach((line, index) => console.log('line #' + index.toString() + ' type=' + EntityType[line.entityType] + ': ' + line.line));
    }

    private genStripped(startLine: number): string {
        let strippedLines = new Array<string>();
        for (let i = startLine; i < this.lines.length; i++) {
            strippedLines.push(this.lines[i].stripped);
        }
        return strippedLines.join('\n');
    }

    private identifyMultiLineComments() {
        let inComment = false;
        for (let i = 1; i < this.lines.length; i++) {
            let line = this.lines[i];
            if (line.entityType !== EntityType.Unknown) {
                continue;
            }
            if (inComment) {
                this.lines[i].entityType = EntityType.MultiLineComment;
                // Note: a multiline comment followed by code on the same
                // line is not supported.
                let endComment = line.stripped.indexOf('*/');
                if (endComment >= 0) {
                    inComment = false;
                    if (line.stripped.lastIndexOf('/*') > endComment + 1) {
                        inComment = true;
                    }
                }
                continue;
            }
            let startComment = line.stripped.indexOf('/*');
            if (startComment >= 0) {
                inComment = true;
                this.lines[i].entityType = EntityType.MultiLineComment;
                if (line.stripped.lastIndexOf('*/') > startComment + 1) {
                    inComment = false;
                }
            }
        }
    }

    private async identifyMainConstructor() {
        const className = this.className + '(';
        for (let i = 1; i < this.lines.length; i++) {
            const line = this.lines[i];
            if (line.entityType !== EntityType.Unknown) {
                continue;
            }
            const offset = line.stripped.indexOf(className);
            if (offset >= 0) {
                if (offset > 0) {
                    const char = line.stripped.substring(offset - 1, offset);
                    if (char !== ' ' && char !== '\t') {
                        continue;
                    }
                }
                this.lines[i].entityType = EntityType.MainConstructor;
                this.theConstructor = await this.markMethod(i, className, EntityType.MainConstructor);
                break;
            }
        }
    }

    private async identifyNamedConstructors() {
        const className = this.className + '.';
        for (let i = 1; i < this.lines.length; i++) {
            const line = this.lines[i];
            if (line.entityType !== EntityType.Unknown) {
                continue;
            }
            const offset = line.stripped.indexOf(className);
            if (offset >= 0) {
                if (offset > 0) {
                    const char = line.stripped.substring(offset - 1, offset);
                    if (char !== ' ' && char !== '\t') {
                        continue;
                    }
                }
                const openParenOffset = offset + line.stripped.substring(offset).indexOf('(');
                const namedConstructor = line.stripped.substring(offset, openParenOffset);
                this.lines[i].entityType = EntityType.NamedConstructor;
                let entity = await this.markMethod(i, namedConstructor, EntityType.NamedConstructor);
                this.namedConstructors.push(entity);
            }
        }
    }

    private async identifyOverrideMethods() {
        for (let i = 1; i < this.lines.length; i++) {
            const line = this.lines[i];
            if (line.entityType !== EntityType.Unknown) {
                continue;
            }

            if (line.stripped.startsWith('@override') && i < this.lines.length - 1) {
                const offset = this.lines[i + 1].stripped.indexOf('(');
                if (offset >= 0) {
                    const ss = this.lines[i + 1].stripped.substring(0, offset);
                    const nameOffset = ss.lastIndexOf(' ') + 1;
                    const name = ss.substring(nameOffset);
                    const entityType = (name === 'build') ? EntityType.BuildMethod : EntityType.OverrideMethod;
                    this.lines[i].entityType = entityType;
                    let entity = await this.markMethod(i + 1, name, entityType);
                    if (name === 'build') {
                        this.buildMethod = entity;
                    } else {
                        this.overrideMethods.push(entity);
                    }
                } else {
                    // No open paren - could be a getter. Find next ';'.
                    let entity = new DartEntity();
                    entity.entityType = EntityType.OverrideMethod;
                    entity.lines.push(this.lines[i]);
                    this.lines[i].entityType = entity.entityType;
                    let lineNum = i + 1;
                    for (let j = i + 1; j < this.lines.length; j++) {
                        entity.lines.push(this.lines[j]);
                        this.lines[j].entityType = entity.entityType;
                        const semicolonOffset = this.lines[j].stripped.indexOf(';');
                        if (semicolonOffset >= 0) {
                            lineNum = j;
                            break;
                        }
                    }
                    for (lineNum = i - 1; isComment(this.lines[lineNum]); lineNum--) {
                        entity.lines.unshift(this.lines[lineNum]);
                        this.lines[lineNum].entityType = entity.entityType;
                    }
                    this.overrideMethods.push(entity);
                }
            }
        }
    }

    private async identifyOthers() {
        for (let i = 1; i < this.lines.length; i++) {
            const line = this.lines[i];
            if (line.entityType !== EntityType.Unknown) {
                continue;
            }

            let entity = await this.scanMethod(i);
            if (entity.entityType === EntityType.Unknown) {
                continue;
            }

            // Preserve the comment lines leading up to the entity.
            for (let lineNum = i - 1; lineNum > 0; lineNum--) {
                if (isComment(this.lines[lineNum])) {
                    this.lines[lineNum].entityType = entity.entityType;
                    entity.lines.unshift(this.lines[lineNum]);
                    continue;
                }
                break;
            }

            switch (entity.entityType) {
                case EntityType.OtherMethod:
                    this.otherMethods.push(entity);
                    break;
                case EntityType.StaticVariable:
                    this.staticVariables.push(entity);
                    break;
                case EntityType.StaticPrivateVariable:
                    this.staticPrivateVariables.push(entity);
                    break;
                case EntityType.InstanceVariable:
                    this.instanceVariables.push(entity);
                    break;
                case EntityType.PrivateInstanceVariable:
                    this.privateVariables.push(entity);
                    break;
                default:
                    console.log('UNEXPECTED EntityType=', entity.entityType);
                    break;
            }
        }
    }

    private scanMethod(lineNum: number): DartEntity {
        let entity = new DartEntity;

        let buf = this.genStripped(lineNum);
        let result = this.findSequence(buf);
        let sequence = result[0];
        let lineCount = result[1];
        let leadingText = result[2];

        const nameParts = leadingText.split(' ');
        let staticKeyword = false;
        let privateVar = false;
        if (nameParts.length > 0) {
            entity.name = nameParts[nameParts.length - 1];
            if (entity.name.startsWith('_')) {
                privateVar = true;
            }
            if (nameParts[0] === 'static') {
                staticKeyword = true;
            }
        }
        entity.entityType = EntityType.InstanceVariable;
        switch (true) {
            case privateVar && staticKeyword:
                entity.entityType = EntityType.StaticPrivateVariable;
                break;
            case staticKeyword:
                entity.entityType = EntityType.StaticVariable;
                break;
            case privateVar:
                entity.entityType = EntityType.PrivateInstanceVariable;
                break;
        }

        switch (sequence) {
            case '=>();':
                entity.entityType = EntityType.OtherMethod;
                break;
            case '=>;':
                entity.entityType = EntityType.OtherMethod;
                break;
            case '=>{}':
                entity.entityType = EntityType.OtherMethod;
                break;
            case '=>[]':
                entity.entityType = EntityType.OtherMethod;
                break;

            case '(){}':
                entity.entityType = EntityType.OtherMethod;
                break;
            case '()=>();':
                entity.entityType = EntityType.OtherMethod;
                break;
            case '()=>;':
                entity.entityType = EntityType.OtherMethod;
                break;
            case '()=>{}':
                entity.entityType = EntityType.OtherMethod;
                break;
            case '()=>[]':
                entity.entityType = EntityType.OtherMethod;
                break;
            case '();':  // Abstract method.
                entity.entityType = EntityType.OtherMethod;
                break;

            case '=(){}':
                entity.entityType = EntityType.OtherMethod;
                break;
            case '=()=>();':
                entity.entityType = EntityType.OtherMethod;
                break;
            case '=()=>;':
                entity.entityType = EntityType.OtherMethod;
                break;
            case '=()=>{}':
                entity.entityType = EntityType.OtherMethod;
                break;
            case '=()=>[]':
                entity.entityType = EntityType.OtherMethod;
                break;
        }

        // Force getters to be methods.
        if (leadingText.indexOf(' get ')) {
            entity.entityType = EntityType.OtherMethod;
        }

        for (let i = 0; i <= lineCount; i++) {
            this.lines[lineNum + i].entityType = entity.entityType;
            entity.lines.push(this.lines[lineNum + i]);
        }

        return entity;
    }

    private findSequence(buf: string): [string, number, string] {
        let result = new Array<string>();

        let leadingText = "";
        let lineCount = 0;
        let openParenCount = 0;
        let openBraceCount = 0;
        let openCurlyCount = 0;
        for (let i = 0; i < buf.length; i++) {
            if (openParenCount > 0) {
                for (; i < buf.length; i++) {
                    switch (buf[i]) {
                        case '(':
                            openParenCount++;
                            break;
                        case ')':
                            openParenCount--;
                            break;
                        case '\n':
                            lineCount++;
                            break;
                    }
                    if (openParenCount === 0) {
                        result.push(buf[i]);
                        break;
                    }
                }
            } else if (openBraceCount > 0) {
                for (; i < buf.length; i++) {
                    switch (buf[i]) {
                        case '[':
                            openBraceCount++;
                            break;
                        case ']':
                            openBraceCount--;
                            break;
                        case '\n':
                            lineCount++;
                            break;
                    }
                    if (openBraceCount === 0) {
                        result.push(buf[i]);
                        return [result.join(''), lineCount, leadingText];
                    }
                }
            } else if (openCurlyCount > 0) {
                for (; i < buf.length; i++) {
                    switch (buf[i]) {
                        case '{':
                            openCurlyCount++;
                            break;
                        case '}':
                            openCurlyCount--;
                            break;
                        case '\n':
                            lineCount++;
                            break;
                    }
                    if (openCurlyCount === 0) {
                        result.push(buf[i]);
                        return [result.join(''), lineCount, leadingText];
                    }
                }
            } else {
                switch (buf[i]) {
                    case '(':
                        openParenCount++;
                        result.push(buf[i]);
                        if (leadingText === '') {
                            leadingText = buf.substring(0, i).trim();
                        }
                        break;
                    case '[':
                        openBraceCount++;
                        result.push(buf[i]);
                        if (leadingText === '') {
                            leadingText = buf.substring(0, i).trim();
                        }
                        break;
                    case '{':
                        openCurlyCount++;
                        result.push(buf[i]);
                        if (leadingText === '') {
                            leadingText = buf.substring(0, i).trim();
                        }
                        break;
                    case ';':
                        result.push(buf[i]);
                        if (leadingText === '') {
                            leadingText = buf.substring(0, i).trim();
                        }
                        return [result.join(''), lineCount, leadingText];
                    case '=':
                        if (i < buf.length - 1 && buf[i + 1] === '>') {
                            result.push('=>');
                        } else {
                            result.push(buf[i]);
                        }
                        if (leadingText === '') {
                            leadingText = buf.substring(0, i).trim();
                        }
                        break;
                    case '\n':
                        lineCount++;
                        break;
                }
            }
        }
        return [result.join(''), lineCount, leadingText];
    }

    private async markMethod(lineNum: number, methodName: string, entityType: EntityType): Promise<DartEntity> {
        let entity = new DartEntity;
        entity.entityType = entityType;
        entity.lines = [];
        entity.name = methodName;

        // Identify all lines within the main (or factory) constructor.
        const lineOffset = this.fullBuf.indexOf(this.lines[lineNum].line);
        const inLineOffset = this.lines[lineNum].line.indexOf(methodName);
        const relOpenParenOffset = lineOffset + inLineOffset + methodName.length - 1;
        const absOpenParenOffset = this.openCurlyOffset + relOpenParenOffset;
        const absCloseParenOffset = await findMatchingParen(this.editor, absOpenParenOffset);
        const relCloseParenOffset = absCloseParenOffset - this.openCurlyOffset;
        const curlyDeltaOffset = this.fullBuf.substring(relCloseParenOffset).indexOf('{');
        const semicolonOffset = this.fullBuf.substring(relCloseParenOffset).indexOf(';');
        let nextOffset = 0;
        if (curlyDeltaOffset >= 0 && semicolonOffset >= 0 && semicolonOffset < curlyDeltaOffset) { // no body.
            nextOffset = relCloseParenOffset + semicolonOffset;
        } else {
            const absOpenCurlyOffset = absCloseParenOffset + curlyDeltaOffset;
            const absCloseCurlyOffset = await findMatchingParen(this.editor, absOpenCurlyOffset);
            nextOffset = absCloseCurlyOffset - this.openCurlyOffset;
        }
        const constructorBuf = this.fullBuf.substring(lineOffset, nextOffset + 1);
        const numLines = constructorBuf.split('\n').length;
        for (let i = 0; i < numLines; i++) {
            this.lines[lineNum + i].entityType = entityType;
            entity.lines.push(this.lines[lineNum + i]);
        }

        // Preserve the comment lines leading up to the method.
        for (lineNum--; lineNum > 0; lineNum--) {
            if (isComment(this.lines[lineNum]) || this.lines[lineNum].stripped.startsWith('@')) {
                this.lines[lineNum].entityType = entityType;
                entity.lines.unshift(this.lines[lineNum]);
                continue;
            }
            break;
        }
        return entity;
    }
}

const matchClassRE = /^(?:abstract\s+)?class\s+(\S+)\s*.*$/mg;

const findMatchingParen = async (editor: vscode.TextEditor, openParenOffset: number) => {
    const position = editor.document.positionAt(openParenOffset);
    editor.selection = new vscode.Selection(position, position);
    await vscode.commands.executeCommand('editor.action.jumpToBracket');
    const result = editor.document.offsetAt(editor.selection.active);
    return result;
};

const isComment = (line: DartLine) => {
    return (line.entityType === EntityType.SingleLineComment ||
        line.entityType === EntityType.MultiLineComment);
};

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, "Flutter Stylizer" is now active!');

    let disposable = vscode.commands.registerCommand('extension.flutterStylizer', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return; // No open text editor
        }
        let saveSelection = editor.selection;

        const classes = await getClasses(editor);
        console.log("Found " + classes.length.toString() + " classes.");

        // Rewrite the classes.
        for (let i = classes.length - 1; i >= 0; i--) {
            const dc = classes[i];
            const startPos = editor.document.positionAt(dc.openCurlyOffset);
            const endPos = editor.document.positionAt(dc.closeCurlyOffset);
            editor.selection = new vscode.Selection(startPos, endPos);

            let lines = new Array<string>();
            lines.push(dc.lines[0].line);  // Curly brace.
            let addEntity = (entity?: DartEntity, separateEntities?: boolean) => {  // separateEntities default is true.
                if (entity === undefined) { return; }
                entity.lines.forEach((line) => lines.push(line.line));
                if (separateEntities === undefined || separateEntities === true) {
                    if (lines.length > 0 && lines[lines.length - 1] !== '\n') { lines.push(''); }
                }
            };
            let addEntities = (entities: Array<DartEntity>, separateEntities?: boolean) => {  // separateEntities default is true.
                entities.forEach((e) => addEntity(e, separateEntities));
                if (separateEntities === false && entities.length > 0 && lines.length > 0 && lines[lines.length - 1] !== '\n') {
                    lines.push('');
                }
            };
            let sortFunc = (a: DartEntity, b: DartEntity) => a.name.localeCompare(b.name);
            addEntity(dc.theConstructor);
            dc.namedConstructors.sort(sortFunc);
            addEntities(dc.namedConstructors);
            dc.staticVariables.sort(sortFunc);
            addEntities(dc.staticVariables, false);
            dc.instanceVariables.sort(sortFunc);
            addEntities(dc.instanceVariables, false);
            dc.staticPrivateVariables.sort(sortFunc);
            addEntities(dc.staticPrivateVariables, false);
            dc.privateVariables.sort(sortFunc);
            addEntities(dc.privateVariables, false);
            dc.overrideMethods.sort(sortFunc);
            addEntities(dc.overrideMethods);
            addEntities(dc.otherMethods);

            // Preserve random single-line and multi-line comments.
            for (let i = 1; i < dc.lines.length; i++) {
                let foundComment = false;
                for (; i < dc.lines.length && isComment(dc.lines[i]); i++) {
                    lines.push(dc.lines[i].line);
                    foundComment = true;
                }
                if (foundComment) { lines.push(''); }
            }

            addEntity(dc.buildMethod);

            editor.edit((editBuilder: vscode.TextEditorEdit) => {
                editBuilder.replace(editor.selection, lines.join('\n'));
            });
        }

        editor.selection = saveSelection;
    });

    const getClasses = async (editor: vscode.TextEditor) => {
        let document = editor.document;
        let classes = new Array<DartClass>();
        const buf = document.getText();
        while (true) {
            let mm = matchClassRE.exec(buf);
            if (!mm) { break; }
            let className = mm[1];
            let classOffset = buf.indexOf(mm[0]);
            let openCurlyOffset = findOpenCurlyOffset(buf, classOffset);
            if (openCurlyOffset <= classOffset) {
                console.log('expected "{" after "class" at offset ' + classOffset.toString());
                return classes;
            }
            let closeCurlyOffset = await findMatchingParen(editor, openCurlyOffset);
            if (closeCurlyOffset <= openCurlyOffset) {
                console.log('expected "}" after "{" at offset ' + openCurlyOffset.toString());
                return classes;
            }
            let dartClass = new DartClass(editor, className, classOffset, openCurlyOffset, closeCurlyOffset);
            await dartClass.findFeatures(buf.substring(openCurlyOffset, closeCurlyOffset));
            classes.push(dartClass);
        }
        return classes;
    };

    const findOpenCurlyOffset = (buf: string, startOffset: number) => {
        const offset = buf.substring(startOffset).indexOf('{');
        return startOffset + offset;
    };

    context.subscriptions.push(disposable);
}

export function deactivate() {
}