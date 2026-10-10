package com.jacob.com;

/** Stand-in for JACOB's COM failure (a RuntimeException carrying SAP's message and an HRESULT). TEST DOUBLE - not the real library. */
public class ComFailException extends RuntimeException {
    private final int hresult;

    public ComFailException(String message) {
        this(message, 0x80004005); // E_FAIL
    }

    public ComFailException(String message, int hresult) {
        super(message);
        this.hresult = hresult;
    }

    public int getHResult() {
        return hresult;
    }
}
