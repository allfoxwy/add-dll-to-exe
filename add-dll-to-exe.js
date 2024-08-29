const fs = require("fs");
const readline = require("readline");


let exe = Buffer.alloc(0);
let peHeaderAddr;
let RVAcalculationTable = [];

function sectionCount(change) {
    if (change) {
        exe.writeUInt16LE(change, peHeaderAddr + 0x06);
    }
    return exe.readUInt16LE(peHeaderAddr + 0x06);
}

function sectionAlignment() {
    return exe.readUInt32LE(peHeaderAddr + 0x38);
}

function fileAlignment() {
    return exe.readUInt32LE(peHeaderAddr + 0x3c);
}

function imageSize(change) {
    if (change) {
        exe.writeUInt32LE(change, peHeaderAddr + 0x50);
    }
    return exe.readUInt32LE(peHeaderAddr + 0x50);
}

function newSectionHeader(name, size, characteristics = 0xe0000060) {
    if (typeof (name) === "string") {
        name = Buffer.from(name, "latin1");
    }

    if (name.length > 7) {
        throw new Error("Section name could have 7 bytes at most.");
    }

    let result = Buffer.alloc(0x28);

    name.copy(result);

    // virtual size
    result.writeUInt32LE(size, 0x08);

    // virtual addr
    let virtualAddressOfLastSectionBefore = exe.readUInt32LE(peHeaderAddr + 0xf8 + (0x28 * (sectionCount() - 1)) + 0x0c);
    let sizeOfLastSectionBefore = exe.readUInt32LE(peHeaderAddr + 0xf8 + (0x28 * (sectionCount() - 1)) + 0x08);
    result.writeUInt32LE(Math.ceil((virtualAddressOfLastSectionBefore + sizeOfLastSectionBefore) / sectionAlignment()) * sectionAlignment(), 0x0c);

    // raw size
    result.writeUInt32LE(Math.ceil(size / fileAlignment()) * fileAlignment(), 0x10);

    // raw addr
    result.writeUInt32LE(Math.ceil(exe.length / fileAlignment()) * fileAlignment(), 0x14);

    result.writeUInt32LE(characteristics, 0x24);

    return result;
}

function insertNewSection(name, data, characteristics = 0xe0000060) {
    let newHeader = newSectionHeader(name, data.length, characteristics);

    let rawAddr = newHeader.readUInt32LE(0x14);

    let headersBefore = exe.subarray(0, peHeaderAddr + 0xf8 + (0x28 * sectionCount()));
    let dataOriginal = exe.subarray(peHeaderAddr + 0xf8 + (0x28 * (sectionCount() + 1)));

    let exePadding = Buffer.alloc(rawAddr - exe.length);

    let paddedData = Buffer.alloc(Math.ceil(data.length / fileAlignment()) * fileAlignment());
    data.copy(paddedData);

    exe = Buffer.concat([headersBefore, newHeader, dataOriginal, exePadding, paddedData]);

    sectionCount(sectionCount() + 1);

    imageSize(imageSize() + Math.ceil(data.length / sectionAlignment()) * sectionAlignment());

    refreshSectionInfo();

    return {
        newRawAddress: rawAddr,
        newRawLength: paddedData.length,
    };
}

function refreshSectionInfo() {
    RVAcalculationTable = [];

    for (let sectionHeaderAddr = peHeaderAddr + 0xf8; sectionHeaderAddr < peHeaderAddr + 0xf8 + sectionCount() * 0x28; sectionHeaderAddr += 0x28) {
        let item = {
            rawAddress: exe.readUInt32LE(sectionHeaderAddr + 0x14),
            virtualAddress: exe.readUInt32LE(sectionHeaderAddr + 0x0c),
            sectionName: readCString(exe, sectionHeaderAddr),
        };

        RVAcalculationTable.push(item);
    }
}

function raw2rva(raw) {
    RVAcalculationTable.sort(function (a, b) {
        return b.rawAddress - a.rawAddress;
    });

    for (let i = 0; i < RVAcalculationTable.length; ++i) {
        if (raw >= RVAcalculationTable[i].rawAddress) {
            return raw - RVAcalculationTable[i].rawAddress + RVAcalculationTable[i].virtualAddress;
        }
    }
    return undefined;
}

function rva2raw(rva) {
    RVAcalculationTable.sort(function (a, b) {
        return b.virtualAddress - a.virtualAddress;
    });

    for (let i = 0; i < RVAcalculationTable.length; ++i) {
        if (rva >= RVAcalculationTable[i].virtualAddress) {
            return rva - RVAcalculationTable[i].virtualAddress + RVAcalculationTable[i].rawAddress;
        }
    }
    return undefined;
}

function writeCString(buffer, offset, str) {
    let code = Buffer.from(str, "latin1");
    code.copy(buffer, offset);

    let ending = Buffer.from([0]);
    ending.copy(buffer, offset + code.length);

    return code.length + ending.length;
}

function readCString(buffer, offset) {
    let end = undefined;
    for (let i = offset; i < buffer.length; ++i) {
        if (buffer[i] === 0) {
            end = i;
            break;
        }
    }

    if (end !== undefined) {
        let source = buffer.subarray(offset, end);
        return source.toString("latin1");
    } else {
        return undefined;
    }
}

function getImportDirectoryLength() {
    let importDirectoryAddr = rva2raw(exe.readUInt32LE(peHeaderAddr + 0x80));
    let result = 0;

    while (true) {
        let name = exe.readUInt32LE(importDirectoryAddr + 0x0c);
        let originalFirstThunk = exe.readUInt32LE(importDirectoryAddr);
        let firstThunk = exe.readUInt32LE(importDirectoryAddr + 0x10);

        if (name === 0 && originalFirstThunk === 0 && firstThunk === 0) {
            break;
        }

        result += 0x14;
        importDirectoryAddr += 0x14;
    }

    return result;
}

function printImports() {
    let importDirectoryAddr = rva2raw(exe.readUInt32LE(peHeaderAddr + 0x80));

    while (true) {
        let name = exe.readUInt32LE(importDirectoryAddr + 0x0c);
        let originalFirstThunk = exe.readUInt32LE(importDirectoryAddr);
        let firstThunk = exe.readUInt32LE(importDirectoryAddr + 0x10);

        if (name === 0 && originalFirstThunk === 0 && firstThunk === 0) {
            break;
        }

        let nameAddr = rva2raw(name);
        console.log(readCString(exe, nameAddr) + ":");

        let importFuncAddr = originalFirstThunk != 0 ? originalFirstThunk : firstThunk;
        importFuncAddr = rva2raw(importFuncAddr);

        while (true) {
            let ILT = exe.readUInt32LE(importFuncAddr);

            if (ILT === 0) {
                break;
            }

            if (ILT & (1 << 31)) {
                let hint = exe.readUInt16LE(importFuncAddr);
                console.log("\t" + hint + "\tImport by ordinal");
            } else {
                let nameAddr = rva2raw(ILT);
                let hint = exe.readUInt16LE(nameAddr);
                console.log("\t" + hint + "\t" + readCString(exe, nameAddr + 2));
            }

            importFuncAddr += 4;
        }

        importDirectoryAddr += 0x14;
    }
}

function isPatched() {
    refreshSectionInfo();

    for (let i of RVAcalculationTable) {
        if (i.sectionName === ".sldll") {
            return true;
        }
    }

    return false;
}


function isPE() {
    try {
        if (exe.readUint16LE(0) !== 0x5a4d) {
            return false;
        }

        peHeaderAddr = exe.readUInt32LE(0x3c);

        let peSignature = exe.readUInt32LE(peHeaderAddr);

        if (peSignature !== 0x4550) {
            return false;
        }

        refreshSectionInfo();

        return true;

    } catch (err) {
        return false;
    }
}


// Disable ExperimentalWarning
const originalEmit = process.emit;
process.emit = function (name, data, ...args) {
  if (
    name === `warning` &&
    typeof data === `object` &&
    data.name === `ExperimentalWarning` 
    //if you want to only stop certain messages, test for the message here:
    //&& data.message.includes(`Fetch API`)
  ) {
    return false;
  }
  return originalEmit.apply(process, arguments);
};



(function main() {
    try {
        let peName;

        if (process.argv.length >= 3) {
            peName = process.argv[2];
        } else {
            let dir = fs.readdirSync(process.cwd());
            dir.forEach(function (file, index) {
                if (file === "WoW_tweaked.exe") {
                    peName = file;
                }
            });

            if (peName === undefined) {
                dir.forEach(function (file, index) {
                    if (file === "WoWFoV.exe") {
                        peName = file;
                    }
                });
            }

            if (peName === undefined) {
                dir.forEach(function (file, index) {
                    if (file === "WoW.exe") {
                        peName = file;
                    }
                });
            }
        }

        if (peName === undefined) {
            throw new Error("Need a PE(.exe) name. You could put this file at the same folder with WoW.exe");
        }

        exe = fs.readFileSync(peName);
        if (!isPE()) {
            throw new Error(peName + " is not a PE(.exe) file.");
        }

        if (isPatched()) {
            throw new Error(peName + " is already patched. Skipping patching.");
        }

        // Buffer contents:
        // - Copied import directory
        // - item for new DLL
        // - ending of directory
        // - new ILT
        // - ILT ending
        // - Original RVA of import directory
        // - new string for import directory
        let sideloadDLLsection = Buffer.alloc(getImportDirectoryLength() + 256);

        let importDirectoryAddr = rva2raw(exe.readUInt32LE(peHeaderAddr + 0x80));
        let b = exe.copy(sideloadDLLsection, 0, importDirectoryAddr, importDirectoryAddr + getImportDirectoryLength());

        // Save original RVA of import directory
        // reserve 1 new item and 1 for ending and 2 for new ILT
        exe.copy(sideloadDLLsection, getImportDirectoryLength() + 0x14 + 0x14 + 4 * 2, peHeaderAddr + 0x80, peHeaderAddr + 0x80 + 4);

        // new ILT
        sideloadDLLsection.writeUInt32LE((((1 << 31) >>> 0) + 1), getImportDirectoryLength() + 0x14 + 0x14);

        // new string for import directory
        writeCString(sideloadDLLsection, getImportDirectoryLength() + 0x14 + 0x14 + 4 * 2 + 4, "sideload-DLL.dll");

        let newSection = insertNewSection(".sldll", sideloadDLLsection);

        // new import directory item
        let ILTrva = raw2rva(newSection.newRawAddress + getImportDirectoryLength() + 0x14 + 0x14)
        let newStrRVA = raw2rva(newSection.newRawAddress + getImportDirectoryLength() + 0x14 + 0x14 + 4 * 2 + 4);
        exe.writeUInt32LE(ILTrva, newSection.newRawAddress + getImportDirectoryLength());
        exe.writeUInt32LE(newStrRVA, newSection.newRawAddress + getImportDirectoryLength() + 0x0c);
        exe.writeUInt32LE(ILTrva, newSection.newRawAddress + getImportDirectoryLength() + 0x10);

        // Point import directory RVA to newly added one
        exe.writeUInt32LE(raw2rva(newSection.newRawAddress), peHeaderAddr + 0x80);

        fs.writeFileSync("WoW_sideload-DLL.exe", exe);

        console.info(peName + " is successfully patched with sideload DLL capability. New file name is WoW_sideload-DLL.exe");
    } catch (err) {
        console.error(err.toString());
    }

    const keypress = async () => {
        process.stdin.setRawMode(true)
        return new Promise(resolve => process.stdin.once('data', () => {
            process.stdin.setRawMode(false)
            resolve()
        }))
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Press ENTER to exit.", (k) => {
        rl.close();
    });

})();

