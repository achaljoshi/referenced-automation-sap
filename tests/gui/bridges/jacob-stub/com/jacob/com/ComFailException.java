package com.jacob.com;

/** Stand-in for JACOB's COM failure (a RuntimeException carrying SAP's message). TEST DOUBLE - not the real library. */
public class ComFailException extends RuntimeException {
    public ComFailException(String message) {
        super(message);
    }
}
