package app.melodious.ssh

import com.jcraft.jsch.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.mockito.Mockito.*

class HubSshProvisionerTest {
    @Test fun inspectUsesExecAndDisconnectsOnRemoteFailure() = runBlocking {
        val client = mock(JSch::class.java)
        val session = mock(Session::class.java)
        val channel = mock(ChannelExec::class.java)
        `when`(client.getSession("root", "fixture.invalid", 2222)).thenReturn(session)
        `when`(session.openChannel("exec")).thenReturn(channel)
        `when`(channel.isClosed).thenReturn(true)
        `when`(channel.exitStatus).thenReturn(7)
        val result = HubSshProvisioner { client }.inspectHubOverSsh("fixture.invalid", "fixture key", 2222)
        assertEquals("SSH exited with code 7", result.exceptionOrNull()?.message)
        verify(channel).setCommand(contains("cat /etc/version"))
        verify(channel).disconnect()
        verify(session).disconnect()
    }
}
