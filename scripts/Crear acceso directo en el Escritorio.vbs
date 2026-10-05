' Crea un acceso directo a BLACK SAND Manager en el Escritorio de Windows.
' Como usarlo: hace doble clic en este archivo UNA sola vez. Despues de eso
' vas a tener un icono "BLACK SAND Manager" en tu Escritorio para abrir la
' app cualquier dia, sin volver a necesitar este archivo.

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectDir = fso.GetParentFolderName(scriptDir)
batPath = scriptDir & "\Iniciar BLACK SAND Manager.bat"

If Not fso.FileExists(batPath) Then
    MsgBox "No se encontro el archivo:" & vbCrLf & batPath & vbCrLf & vbCrLf & _
           "Este archivo tiene que quedar junto a 'Iniciar BLACK SAND Manager.bat', " & _
           "dentro de la carpeta 'scripts' del proyecto. No los muevas por separado.", _
           vbCritical, "BLACK SAND Manager"
    WScript.Quit 1
End If

desktopPath = shell.SpecialFolders("Desktop")
shortcutPath = desktopPath & "\BLACK SAND Manager.lnk"

Set shortcut = shell.CreateShortcut(shortcutPath)
shortcut.TargetPath = batPath
shortcut.WorkingDirectory = projectDir
shortcut.Description = "Abrir BLACK SAND Manager"
shortcut.WindowStyle = 1

electronIcon = projectDir & "\node_modules\electron\dist\electron.exe"
If fso.FileExists(electronIcon) Then
    shortcut.IconLocation = electronIcon & ",0"
Else
    shortcut.IconLocation = "%SystemRoot%\System32\shell32.dll,220"
End If

shortcut.Save

MsgBox "Listo. Se creo el acceso directo 'BLACK SAND Manager' en tu Escritorio." & vbCrLf & vbCrLf & _
       "De ahora en adelante, usa ese icono para abrir la app (podes borrar este archivo .vbs, " & _
       "ya cumplio su funcion).", vbInformation, "BLACK SAND Manager"
