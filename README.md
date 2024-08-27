# add-dll-to-exe
This is a Node.js program which would edit PE import directory so that when run PE, additional DLL would be loaded.

Primary intent of this tool is to pair PE executeable with a self-made DLL which would detour Win32 API. When PE call such API, arbitrary code could be executed.

The detour process could be achieved via library like [MinHook](https://github.com/TsudaKageyu/minhook) or [Detours](https://github.com/microsoft/Detours).

It has no dependency. You could call it easily as `node add-dll-to-exe.js [PE name]`
The DLL which would be loaded is "sideload-DLL.dll", you could edit this name in source.

Currently offsets are hard-coded for x32 PE.
