package com.jacob.activeX;

import com.jacob.com.Dispatch;

/** Stand-in for JACOB's ActiveXComponent: only the SAP ROT wrapper exists. TEST DOUBLE - not the real library. */
public class ActiveXComponent extends Dispatch {
    public ActiveXComponent(String progId) {
        super(progId);
    }
}
