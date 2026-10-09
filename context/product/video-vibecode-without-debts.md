[0-6] In this video, I will tell you how to wipecode without endless changes and how not to accumulate those debts.
[6-10] I will also tell you why many of you do not wipecode correctly.
[10-14] Most of you, at least those who just start, wipecode approximately like this.
[14-22] You write a prompt, get some code, see the error, fix it and then the cycle starts again in a circle.
[22-27] I remember when I just started, you know, the project starts for the first time, you immediately have euphoria.
[27-31] Developers are not needed at once, and no one needs you, you can do it yourself.
[31-33] This is a feeling of deception.
[33-41] Those who have progressed further and went to a more difficult project already understand that you need to start asking for a schedule to make a plan,
[41-43] and only then move to development.
[43-48] The planning mode is basically in any popular wipecoding software.
[48-55] Those who are even cooler use special skills like superpowers or metpocoque skills.
[55-59] But even such a approach is not enough for serious applications.
[59-67] Now I will show you how I organize my development so that I do not have to constantly correct mistakes and correct the already written code.
[67-71] In this video, there will be general recommendations that will suit the majority.
[71-76] However, I want to note that this video has a directorial version in our closed community,
[76-80] links in the description and in the QR code that you can now see on the screen.
[80-82] Well, let's continue.
[82-85] Any development should start with discussion of the task.
[85-93] And the main goal of this stage is how you can take a closer look at the future of the project.
[93-99] First, you can just ask an agent to interview you and pull out the questions you need.
[99-106] Of course, it is more convenient for this to use the skills of brainstorming from superpowers or skill grill me.
[106-108] Links to everything I will leave in the description.
[108-117] You describe your idea of ​​the neurons and then it asks you specific questions that close the white spots on which they can arise.
[117-123] You discuss functionality, architecture, choose a technological stack.
[123-128] It is important to give the agent the maximum context and take the main decisions in advance.
[128-131] And after that, the agent makes you a specification.
[131-138] This is a detailed technical task in which it describes how your application will be arranged.
[138-141] Functions, database schemes and so on.
[141-147] And now the agent, when he will read this specification, even in the new session,
[147-151] he will not lose context, he will remember what project you are working on
[151-152] and remember the main points.
[152-154] This is already a small plus.
[154-159] In skills, it is usually written, but if you create a spec with your own hands,
[159-164] then be sure to ask the agent to remember in the rules that when you go away from the functionality,
[164-170] do some other logic, then the spec should always be updated.
[170-172] The specification should be the source of the truth.
[172-177] It is desirable to read this spec that the agent created and look through your eyes.
[177-182] But there are many technical blocks here, with which you just don't understand.
[182-186] Therefore, read my advice from corner to corner.
[186-188] Almost no one follows.
[188-194] As a result, you get a project that differs from what you thought about.
[194-199] It is already too late to redo and it is difficult to cross the whole project.
[199-204] Therefore, in addition to the technical specifications that the agent uses,
[204-210] I also highly recommend to separately fix the product requirements in the file,
[210-213] which I often call the product spec.
[213-215] And this file is for you.
[215-220] In it, the human language should be described as the application should work
[220-224] from the point of view of the user, without technical details.
[224-228] Here it is necessary to read the product specification.
[228-234] If you make mistakes here, they will go through all subsequent stages of development.
[234-239] And the later you notice this mistake, the more it affects,
[239-241] it will make an impact on your project.
[241-247] Next, we break the project into small stages and write a plan for each stage.
[247-253] If the specification describes the application's structure in general,
[253-258] then each specific plan contains specific technical instructions.
[258-261] What code to write, what files to change,
[261-264] what apps to interact with, and so on.
[265-269] In addition, make your agent, before planning something,
[269-273] be sure to contact the current documentation of the library.
[273-278] Otherwise, he can use outdated functions, which he remembers from training,
[278-282] but which are no longer in real libraries, they are outdated.
[282-285] This is not a recommendation, for the sake of recommendation,
[285-290] this is a feature in practice, which helps with a huge number of mistakes.
[290-293] For this, there is a wonderful mcp-contact 7
[294-297] and before writing a code, before planning something,
[297-300] the agent must contact the current library.
[300-304] And the important thing is that the agent often forgets what to do,
[304-309] forgets to call this mcp, so ask the agent to fix it in the memory of the rule.
[309-314] First, we study the documentation, then we plan something or write a code.
[314-319] One more thing, before developing, we must determine the criteria and techniques
[319-323] that exactly should work, so that we can consider our task fulfilled.
[323-328] For example, for the payment system, the user can initiate the payment from the application,
[328-332] after the payment, the user immediately gets their access,
[332-335] does not break the script, repeat requests,
[336-340] and at the same time, after we have rolled out the payment to all the users,
[340-343] and the rest of the application should not break.
[344-348] This is an example of how check criteria can look like.
[348-354] The agent must not determine whether the work is done well enough.
[354-359] There must be some objective result and the criteria and techniques provide us with it.
[359-364] I repeat, there are specialized skills that teach the agent
[364-368] about all the above processes, branch storming, specifications, plan,
[369-373] development through tests, test the result,
[373-377] and I recommend beginners to start with them, the link will be in the description.
[378-384] But the presence of all these tools does not guarantee that the agent will understand the task correctly
[384-388] and realize what you need, and does not guarantee that in the end,
[388-392] when you are sure that the project is completely completed,
[393-397] it will not be clear that the model has put in a long time some key function
[397-400] and did not tell you about it and completely forgot about it.
[400-404] Therefore, the development control is still necessary.
[404-407] I have already mentioned earlier about the development through testing,
[407-410] or test drive development, or TDD,
[410-415] let's deal with you what it is, how it works, how to use it.
[415-420] In general, the test itself is a small script that checks your application.
[420-424] The tests are automatically checked how the functions work,
[424-427] whether they work as they were intended,
[427-431] and if you have some mistakes, the tests are automatically found.
[431-437] For example, the test can check whether you have the right authorization on the site,
[437-442] that when you enter the correct password, the server returns the token for the authorization,
[442-447] and the input occurs, you get into the dashboard of some personal office,
[447-451] and when you enter the wrong password, the server returns the error,
[451-454] and this error is shown in the interface.
[454-456] This is an example.
[456-461] Next, let's say you developed a payment system on your website,
[461-466] you run the tests, and then bam, the authorization tests fall.
[467-470] What you used to work, for some reason, broke.
[470-474] You are already working with your file as a function.
[474-476] This is actually a common situation,
[476-483] and the agent who sees the fallen test immediately goes to find out what happened there after our changes.
[483-490] Without the tests, you would have noticed it only when the user would start knocking on your face
[490-493] about not being able to enter your account.
[493-495] An important point.
[495-500] First, the tests are written, then they are checked, whether they fall or not,
[500-503] and they should fall because this is their normal behavior,
[503-506] because the code that they check is not yet written.
[506-510] After that, the development starts, and the agent writes the code
[510-513] and does so that the tests become all green,
[513-514] so that they do not fall.
[514-517] When your tests become green, and when they start to fall,
[517-521] it means that your function works as it was intended.
[521-524] It is important to write the tests before the code,
[524-528] because if you start covering the tests with a ready-made application,
[528-532] then the agent will chase them under the working function,
[532-534] and they will just be non-objective.
[534-538] And only after that the writing process of the code begins.
[538-542] Super, the development through testing, we learned from you,
[542-544] but it is still not enough.
[544-547] The tests called earlier check how the code works,
[547-550] let's say under the hood.
[550-554] It can work correctly, but the user in the browser
[554-556] can see a completely sad picture,
[556-560] and then the speech will go about the browser tests.
[560-561] In general, this is a material of my training,
[561-565] but I believe that everyone should know about it.
[565-569] We try on ourselves a QA, a test specialist,
[569-574] and together with the agent we make the so-called case test
[574-576] for all possible situations.
[577-578] Let's take authorization.
[578-580] This is what it looks like.
[580-582] We have some conditions,
[582-585] and there are algorithms that we need to perform.
[585-587] Let's say, open the login page,
[587-591] enter such an email, enter such a password,
[591-594] click enter, and what result we expect from you.
[595-597] Let's say the password is correct,
[597-601] and it means that we have to transfer to the main page.
[601-604] If this happened, then the case test was successful.
[604-610] It was a positive case test that describes the behavior of the system
[610-613] when everything is fine, when the user behaves as needed.
[613-617] Also, you must think of a negative case test
[617-620] when the user enters the wrong password,
[620-623] tries to enter the mail without a symbol of a dog,
[623-627] or enters a thousand symbols in the field of the password.
[627-630] And the negative cases are much more than positive,
[630-634] and each of them must react correctly.
[634-637] Then we give the agent a task to take these case tests
[637-641] and write browser tests through the Playwright MCP.
[641-643] The link will also be in the description.
[643-646] It allows you to run your application through a browser
[646-649] and control how it makes it a real user.
[649-651] Click on the button.
[651-653] And the third is a security check.
[653-655] This is also a very important step,
[655-658] especially if you are developing authorization, payments,
[658-660] and working with user data.
[660-664] There is a special team in the Cloud Code
[664-665] called Security Review.
[665-670] You can enter it after working on any stage.
[670-672] And at the very end, our result,
[672-674] which the agent wrote,
[674-676] is verified with the criteria of the reception,
[676-678] which we have determined with you
[678-682] when planning our application, our functionality.
[682-686] The important step before the start of the development
[686-689] I highly recommend connecting the Git,
[689-690] the system of the control of the version.
[690-693] Git allows you to save the history of changes
[693-697] and return to the previous version of your application.
[697-700] If something went wrong, it allows you to roll back.
[701-703] It also allows you to develop a new functionality
[703-704] in separate branches,
[704-708] while not touching the main version of the application.
[708-709] And at the same time,
[709-712] if several agents work on the project at the same time,
[713-717] I highly recommend using the so-called Git WorkTrees.
[718-722] Each agent has its own version of the project
[722-723] in a separate folder.
[723-724] Here it works in it.
[725-727] And when the work is complete,
[727-731] all WorkTrees merge into one branch.
[731-734] If some agent enters the territory of another agent,
[734-736] then at the stage of merging,
[736-738] they will have a conflict.
[738-739] But it's okay,
[739-740] they won't bite each other.
[741-743] This happens when both agents
[743-745] set up the same file
[746-748] developing their own functionality.
[748-749] At this stage,
[749-751] all conflicts are solved
[751-754] and your code becomes a single target.
[754-755] After each stage is completed,
[755-757] we check the result.
[757-760] If the agent writes that everything is ready,
[760-761] that you can see,
[761-764] it is not considered a proof.
[764-766] Real checks are needed,
[766-769] and that's why all the above tests were written.
[769-771] We need real proof that
[771-773] auto tests, browser tests were passed
[773-776] and our criteria of reception were executed.
[776-779] If the test is green and the functionality works as planned,
[779-782] then you can move on to the next task.
[782-785] And if the application is already launched,
[786-790] the new code cannot be sent to production immediately.
[790-793] For this, there is the so-called staging.
[793-795] This is a separate circle.
[795-797] This is a copy of your production.
[797-801] And in it, you check the new version of the application before the release.
[801-803] For example, I am working on a parser
[803-805] for Freelance Bersh and Telegram Canals, chats.
[806-808] And I have a separate version,
[808-809] which no one sees,
[809-810] which is not available to anyone.
[810-813] And here I am testing the whole functionality.
[813-814] This test circle,
[814-817] which allows me to test
[817-820] in almost a combat state
[820-822] the whole functionality that I develop
[822-824] before the launch of real users.
[824-826] And at this point, when I wrote the script,
[826-829] I realized that if you tell it in detail,
[829-831] then the video will come out at 8 o'clock.
[832-835] But in fact, the basic development process looks like this.
[835-837] We discussed the task,
[837-838] wrote the specification,
[838-840] wrote the plans.
[840-842] According to these plans, we developed the code.
[842-844] Well, first of all, we wrote the tests,
[844-847] developed the code, tested it.
[847-850] And after that, we send it to the release
[850-852] through staging, or not, to decide for you.
[852-855] For small applications and simple bots,
[855-858] this system is, in principle, quite enough.
[858-860] But in something more complicated,
[860-864] even if you ignore everything I said earlier,
[864-867] it will most likely start to have problems.
[867-869] And I will tell you about them at the end of the video.
[869-871] But I will immediately say that development
[871-873] is far from the main thing.
[873-876] For example, I have training on vibe coding
[876-878] from 0 to working products.
[878-879] And even after learning,
[879-881] developing serious applications,
[881-882] designing architecture,
[882-885] working with security, testing, and so on,
[885-888] even by mastering these tools,
[888-891] you will eventually be in the swamp of the same vibe coders
[891-893] who know how to create an application,
[893-896] but have no idea how to sell it.
[896-898] We rebuilt our training,
[898-901] and while others endlessly approach
[901-902] the benchmarks of new models
[902-904] and just teach vibe coding,
[904-907] after meeting with the main tools,
[907-910] you immediately learn to sell your services.
[910-911] We create a portfolio,
[911-913] launch a search system for clients,
[913-915] I give my own generation scheme
[915-918] that brings me up to 50 leads per month.
[918-920] Searching for clients takes time,
[920-923] therefore, only when the whole system is working
[923-924] and the process is launched,
[924-928] then we dive deep into development.
[928-929] There is a deadline without a payment.
[929-931] Your training starts right away,
[931-934] and the first payment you pay only in a month.
[934-936] And you will have a whole month
[936-938] to learn to find clients,
[938-941] while others just keep digging into neurons.
[941-942] The link is in the description,
[942-944] reviews from real people.
[944-947] The vibe 1 promo code gives you a 15% discount
[947-950] exclusively for the viewers of this YouTube channel.
[950-952] But let's get back to the development.
[952-955] As I said, even if you include all these tools,
[955-957] you may have problems.
[957-960] Let's say you don't need to go far.
[960-960] During the work,
[960-964] the agent can make a decision on his own,
[964-965] without reading you,
[965-968] and you may not even know about these decisions.
[968-971] Also, the agent can form a script for those debts,
[971-972] just digging into the task,
[972-974] putting them on later,
[974-976] and then forgetting about what he put off.
[976-978] Next, as the project grows,
[978-982] the agent will become more and more difficult to navigate.
[982-985] He will spend more and more tokens on the search.
[985-988] Also, after the press of the context,
[988-990] the agent may lose information
[990-991] about the previous decisions
[991-994] and the state of development.
[994-995] And another problem,
[995-998] successful tests still do not guarantee
[998-1002] that your application is fully in your demand.
[1002-1004] Therefore, in real work,
[1004-1006] we add a regular process
[1006-1010] to our several additional mechanisms.
[1010-1010] For example,
[1010-1013] ask the agent in a separate file
[1013-1016] to make a story of the decisions he made.
[1016-1018] What was the decision?
[1018-1019] What was the initial question?
[1019-1020] What does it affect?
[1020-1022] What are the consequences?
[1022-1024] And even after each stage,
[1024-1026] this document is updated.
[1026-1029] Your task is to carefully read it.
[1029-1032] Because the decision that the agent makes automatically
[1032-1033] and does not tell you about it,
[1033-1036] is very often not quality.
[1036-1037] Next,
[1037-1040] we have a code card in each project.
[1040-1043] This is a scheme that explains the agent
[1043-1044] where the modules are,
[1044-1046] what is responsible for,
[1046-1048] how the modules are connected to each other,
[1048-1049] and so on.
[1049-1050] Thus, the agent does not spend
[1050-1052] much time every time
[1052-1056] to get to know the project again,
[1056-1057] to build another bike
[1057-1060] when there is already a helicopter in the project.
[1060-1061] Some of my teams
[1061-1064] carry a card in a regular MD file.
[1064-1066] Some use a special MCP
[1066-1068] that builds graphs.
[1068-1069] It is not important,
[1069-1071] the main thing is to enter this card
[1071-1073] and also update.
[1073-1075] After each stage,
[1075-1078] the agent must send a report
[1078-1079] about what he did,
[1079-1080] what decisions he made,
[1080-1082] what new bugs he noticed,
[1082-1084] and it is forbidden for him
[1085-1087] to put it in those files.
[1087-1090] Only after the agreement with me.
[1090-1091] In short, a lot of things.
[1091-1092] Again, if you are a beginner
[1092-1094] or are developing small applications
[1094-1096] or small automation,
[1096-1099] you will have enough
[1099-1102] about what I told you today.
[1102-1103] I have already started to tell
[1103-1104] our own features
[1104-1106] that we introduce to our work
[1106-1108] for more serious projects.
[1108-1110] A small spirit is already starting
[1110-1112] and people do not watch this on YouTube
[1112-1114] and people make me hold the video
[1114-1117] so I will tell you about these things
[1117-1118] in detail in the continuation
[1118-1121] of our closed telegram channel.
[1121-1122] The link in the description
[1122-1123] or QR code on the screen
[1123-1126] is the director version of this video.
[1126-1127] I say goodbye to you.
[1127-1129] Thank you for watching.
[1129-1130] It was useful.
