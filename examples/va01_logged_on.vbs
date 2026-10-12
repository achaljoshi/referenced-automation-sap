If Not IsObject(application) Then
   Set SapGuiAuto  = GetObject("SAPGUI")
   Set application = SapGuiAuto.GetScriptingEngine
End If
If Not IsObject(connection) Then
   Set connection = application.Children(0)
End If
If Not IsObject(session) Then
   Set session    = connection.Children(0)
End If
If IsObject(WScript) Then
   WScript.ConnectObject session,     "on"
   WScript.ConnectObject application, "on"
End If
session.findById("wnd[0]").maximize
session.findById("wnd[0]/tbar[0]/okcd").text = "/nVA01"
session.findById("wnd[0]").sendVKey 0
session.findById("wnd[0]/usr/ctxtVBAK-AUART").text = "OR"
session.findById("wnd[0]/usr/ctxtVBAK-VKORG").text = "1000"
session.findById("wnd[0]/usr/ctxtVBAK-VTWEG").text = "10"
session.findById("wnd[0]/usr/ctxtVBAK-SPART").text = "00"
session.findById("wnd[0]").sendVKey 0
session.findById("wnd[0]/usr/ctxtKUAGV-KUNNR").text = "1000"
session.findById("wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/ctxtRV45A-MABNR[1,0]").text = "TG11"
session.findById("wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/txtRV45A-KWMENG[3,0]").text = "5"
session.findById("wnd[0]/tbar[0]/btn[11]").press
